import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { nativePeerRpc, registerNativeTransport } from '../src/app/native-transport.ts'
import { nativeEventId, nativeSessionId, nativeWorkspaceId } from '../src/app/native-aggregate.ts'
import { nativeToken } from '../src/app/native-auth.ts'

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
type UpgradeHandler = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void
type RpcEnvelope = {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}
type PeerReply =
  | { ok: true; value?: unknown }
  | { ok: false; error: { code: string; message: string; details: object } }
type StreamRequest = {
  type: 'open'
  streamId: string
  endpoint: string
  payload: unknown
}

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function listen(server: Server, port = 0): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** A loopback port nothing listens on yet, for a deployment that starts after the controller. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

/** A Desktop profile with no Sessions of its own: empty baselines and a ready event stream. */
function emptyDesktopStream(request: StreamRequest, send: (value: unknown) => void): void {
  if (request.endpoint === 'workspace/follow') {
    send({ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } })
  } else if (request.endpoint === 'session/control') {
    send({ type: 'baseline', value: { projections: {} } })
  } else if (request.endpoint === '$events') {
    send({ type: 'ready', clientId: 'desktop-event-client', host: { home: '/Users/alice' } })
  }
}

/** Provision the native capabilities that each fixture deployment would create during its own startup. */
function provisionFleet(state: string): void {
  try {
    const registry = JSON.parse(readFileSync(join(state, 'fleet.json'), 'utf8')) as { deployments?: { stateDir: string }[] }
    for (const deployment of registry.deployments ?? []) nativeToken(deployment.stateDir)
  } catch { /* The controller can also start with no registry. */ }
}

type LocalDesktop = {
  onHttp?: (envelope: RpcEnvelope) => PeerReply | Promise<PeerReply>
  onStream?: (request: StreamRequest, send: (value: unknown) => void) => void | Promise<void>
}

/** A controller profile whose own Desktop API answers through `local`, as the Desktop Host does behind the controller. */
async function controllerHarness(state: string, local: LocalDesktop = {}): Promise<string> {
  provisionFleet(state)
  let connectionRequest: ((request: IncomingMessage, response: ServerResponse, next: () => Promise<void>) => Promise<void>) | undefined
  let controllerUpgrade: UpgradeHandler | undefined
  let localNative: Handler | undefined
  const ctx = {
    webServer: {
      host: '127.0.0.1' as const,
      port: 0,
      register: (route: { handler: Handler }) => {
        localNative = route.handler
        return () => { localNative = undefined }
      },
      registerUpgrade: (route: { handler: UpgradeHandler }) => {
        controllerUpgrade = route.handler
        return () => { controllerUpgrade = undefined }
      },
    },
    connection: { requestRejection: () => undefined, authenticatedUrl: (base: string) => `${base}/login` },
    logger: { warn: vi.fn() },
    on: (_event: string, handler: NonNullable<typeof connectionRequest>) => {
      connectionRequest = handler
      return () => { connectionRequest = undefined }
    },
  }
  const dispose = registerNativeTransport(ctx as never, state, 'control')
  cleanup.push(dispose)
  const localMux = new WebSocketServer({ noServer: true })
  cleanup.push(() => new Promise<void>(resolve => localMux.close(() => resolve())))
  const localApi = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const envelope = JSON.parse(Buffer.concat(chunks).toString() || '{}') as RpcEnvelope
    const reply = await local.onHttp?.(envelope) ?? { ok: true, value: undefined }
    const body = JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: reply })
    // The Desktop Host compresses API responses for clients that accept gzip.
    if (request.headers['accept-encoding']?.includes('gzip')) {
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      response.end(gzipSync(body))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(body)
  }
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (path === '/login') {
      response.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-test=local; HttpOnly; Path=/' }).end()
      return
    }
    if (path.startsWith('/orchestrator/native/api')) {
      if (localNative === undefined) throw new Error('controller local native route is not installed')
      void localNative(request, response)
      return
    }
    if (connectionRequest === undefined) throw new Error('controller native HTTP interceptor is not installed')
    void connectionRequest(request, response, async () => {
      if (request.headers.cookie !== 'dsh-auth-test=local') {
        response.writeHead(401).end()
        return
      }
      await localApi(request, response)
    })
  })
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (path === '/api/remote.mux' && request.headers.cookie === 'dsh-auth-test=local') {
      localMux.handleUpgrade(request, socket, head, client => {
        cleanup.push(() => client.terminate())
        client.on('message', data => {
          const frame = JSON.parse(data.toString()) as StreamRequest | { type: string }
          if (frame.type !== 'open') return
          const open = frame as StreamRequest
          const send = (value: unknown): void => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'item', streamId: open.streamId, value }))
            }
          }
          void (local.onStream ?? emptyDesktopStream)(open, send)
        })
      })
      return
    }
    if (controllerUpgrade === undefined) throw new Error('controller native upgrade route is not installed')
    controllerUpgrade(request, socket, head)
  })
  const url = await listen(server)
  ctx.webServer.port = Number(new URL(url).port)
  return url
}

async function peerHarness(options: {
  stateDir: string
  port?: number
  onHttp?: (envelope: RpcEnvelope) => PeerReply | Promise<PeerReply>
  onStream?: (request: StreamRequest, send: (value: unknown) => void) => void | Promise<void>
}): Promise<{
  url: string
  calls: RpcEnvelope[]
  streamRequests: StreamRequest[]
  uplinks: unknown[]
  /** Stop serving, as a restarting deployment does: drop its Remote streams and free its port. */
  stop: () => Promise<void>
}> {
  const calls: RpcEnvelope[] = []
  const streamRequests: StreamRequest[] = []
  const uplinks: unknown[] = []
  const mux = new WebSocketServer({ noServer: true })
  cleanup.push(() => new Promise<void>(resolve => mux.close(() => resolve())))
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/orchestrator/native/api' && !url.pathname.startsWith('/orchestrator/native/api/')) {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const envelope = JSON.parse(Buffer.concat(chunks).toString()) as RpcEnvelope
    calls.push(envelope)
    const reply = await options.onHttp?.(envelope) ?? { ok: true, value: undefined }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: reply }))
  })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/orchestrator/native/remote.mux') {
      socket.destroy()
      return
    }
    mux.handleUpgrade(request, socket, head, client => {
      cleanup.push(() => client.terminate())
      client.on('message', data => {
        const frame = JSON.parse(data.toString()) as StreamRequest | {
          type: 'item' | 'end' | 'cancel'
          streamId: string
          value?: unknown
        }
        if (frame.type === 'open') {
          streamRequests.push(frame)
          const send = (value: unknown): void => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value }))
            }
          }
          void options.onStream?.(frame, send)
          return
        }
        uplinks.push(frame)
      })
    })
  })
  return {
    url: await listen(server, options.port),
    calls,
    streamRequests,
    uplinks,
    stop: async () => {
      for (const client of mux.clients) client.terminate()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function frameReader(socket: WebSocket): () => Promise<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = []
  const waiters: ((value: Record<string, unknown>) => void)[] = []
  socket.on('message', data => {
    const value = JSON.parse(data.toString()) as Record<string, unknown>
    const waiter = waiters.shift()
    if (waiter !== undefined) waiter(value)
    else queue.push(value)
  })
  return () => new Promise((resolve, reject) => {
    const queued = queue.shift()
    if (queued !== undefined) {
      resolve(queued)
      return
    }
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Remote mux frame')), 3_000)
    waiters.push(value => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

async function openMux(url: string): Promise<{ socket: WebSocket; next: () => Promise<Record<string, unknown>> }> {
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/orchestrator/native/remote.mux`)
  cleanup.push(() => socket.terminate())
  await socketOpen(socket)
  return { socket, next: frameReader(socket) }
}

async function nativeCall(url: string, method: string, payload: unknown, rpcId = method): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  expect(response.status).toBe(200)
  return await response.json() as Record<string, unknown>
}

it('accepts a successful unary RPC that has no value', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-rpc-void-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const peer = await peerHarness({
    stateDir: state,
    onHttp: () => ({ ok: true }),
  })
  const target = {
    id: 'sglang',
    remote: false,
    repository: 'onenexus-team/sglang',
    url: peer.url,
    nativeUrl: peer.url,
    profile: 'superagent-sglang',
    stateDir: state,
    workspace: '/tmp/sglang',
    token: nativeToken(state)!,
  }

  await expect(nativePeerRpc(target, 'credentials/set', {
    ref: 'EXAMPLE_API_KEY',
    value: 'not-returned',
  })).resolves.toBeUndefined()
})

function socketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

it('keeps unscoped API traffic on the Desktop profile and authenticates a deployment Session stream separately', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-proxy-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const targetState = join(state, 'superagent-sglang')
  mkdirSync(targetState)

  let targetPort = 0
  let targetHttp: Handler | undefined
  let targetUpgrade: UpgradeHandler | undefined
  const received: { path: string; body: string; internal: string | undefined }[] = []
  const operatorPeers = new Map<string, 'none' | 'answer'>()
  const issuedOperators: ('none' | 'answer')[] = []
  let operatorSequence = 0
  const admit = vi.fn(() => ({ rejection: 401 as const }))
  const targetCtx = {
    webServer: {
      host: '127.0.0.1' as const,
      get port() { return targetPort },
      register: (route: { handler: Handler }) => {
        targetHttp = route.handler
        return () => { targetHttp = undefined }
      },
      registerUpgrade: (route: { handler: UpgradeHandler }) => {
        targetUpgrade = route.handler
        return () => { targetUpgrade = undefined }
      },
    },
    connection: {
      authenticatedUrl: (base: string) => `${base}/?token=test`,
      admit,
    },
    logger: { warn: vi.fn() },
  }
  const localMux = new WebSocketServer({ noServer: true })
  cleanup.push(() => new Promise<void>(resolve => localMux.close(() => resolve())))
  let localClosed: (() => void) | undefined
  const localClose = new Promise<void>(resolve => { localClosed = resolve })
  const targetServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (path.startsWith('/orchestrator/native/api')) {
      if (targetHttp === undefined) throw new Error('target native HTTP route is not installed')
      void targetHttp(request, response)
      return
    }
    if (path.startsWith('/api/')) {
      void (async () => {
        const cookie = request.headers.cookie
        if (cookie === undefined || !operatorPeers.has(cookie)) {
          response.writeHead(401).end()
          return
        }
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = Buffer.concat(chunks).toString()
        received.push({
          path,
          body,
          internal: request.headers['x-dsh-superagent-native'] as string | undefined,
        })
        response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'dsh-auth-test=private; HttpOnly; Path=/' })
        response.end(JSON.stringify({ path, body }))
      })()
      return
    }
    const interactions = url.searchParams.get('interactions') ?? 'none'
    const operator = `${interactions}-${++operatorSequence}`
    operatorPeers.set(`dsh-auth-test=${operator}`, interactions as 'none' | 'answer')
    issuedOperators.push(interactions as 'none' | 'answer')
    response.writeHead(path === '/connect' ? 302 : 303, {
      location: './api/remote.mux',
      'set-cookie': `dsh-auth-test=${operator}; HttpOnly; Path=/`,
    }).end()
  })
  targetServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (path === '/orchestrator/native/remote.mux') {
      if (targetUpgrade === undefined) throw new Error('target native upgrade route is not installed')
      targetUpgrade(request, socket, head)
      return
    }
    const cookie = request.headers.cookie
    if (path !== '/api/remote.mux' || cookie === undefined || !operatorPeers.has(cookie)) {
      socket.destroy()
      return
    }
    localMux.handleUpgrade(request, socket, head, client => {
      client.on('message', data => {
        const frame = JSON.parse(data.toString()) as { type: string; streamId: string; payload?: unknown }
        if (frame.type === 'open') {
          client.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { echo: frame.payload } }))
        }
      })
      client.once('close', () => {
        operatorPeers.delete(cookie)
        localClosed?.()
      })
    })
  })
  const targetUrl = await listen(targetServer)
  targetPort = Number(new URL(targetUrl).port)
  const disposeTarget = registerNativeTransport(targetCtx as never, targetState, 'repository')
  cleanup.push(disposeTarget)

  let controllerPort = 0
  let connectionRequest: ((request: IncomingMessage, response: ServerResponse, next: () => Promise<void>) => Promise<void>) | undefined
  let controllerUpgrade: UpgradeHandler | undefined
  const controllerCtx = {
    webServer: {
      host: '127.0.0.1' as const,
      get port() { return controllerPort },
      register: () => () => {},
      registerUpgrade: (route: { handler: UpgradeHandler }) => {
        controllerUpgrade = route.handler
        return () => { controllerUpgrade = undefined }
      },
    },
    connection: { requestRejection: () => undefined, authenticatedUrl: (base: string) => `${base}/?token=test` },
    logger: { warn: vi.fn() },
    on: (_event: string, handler: NonNullable<typeof connectionRequest>) => {
      connectionRequest = handler
      return () => { connectionRequest = undefined }
    },
  }
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1, controlScript: '/usr/bin/true', logDir: state,
    deployments: [{ id: 'sglang', profile: 'superagent-sglang', repository: 'onenexus-team/sglang',
      url: targetUrl, stateDir: targetState, workspace: '/Users/alice/src/sglang-superagent' }],
  }))
  writeFileSync(join(state, 'native-deployment.json'), JSON.stringify({ version: 1, deployment: 'sglang' }))
  const disposeController = registerNativeTransport(controllerCtx as never, state, 'control')
  cleanup.push(disposeController)
  const controllerServer = createServer((request, response) => {
    if (connectionRequest === undefined) throw new Error('controller native HTTP interceptor is not installed')
    void connectionRequest(request, response, async () => {
      response.writeHead(500).end('controller-local API reached')
    })
  })
  controllerServer.on('upgrade', (request, socket, head) => {
    if (controllerUpgrade === undefined) throw new Error('controller native upgrade route is not installed')
    controllerUpgrade(request, socket, head)
  })
  const controllerUrl = await listen(controllerServer)
  controllerPort = Number(new URL(controllerUrl).port)

  const response = await fetch(`${controllerUrl}/api/session/list?limit=5`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: 'fixture' }),
    signal: AbortSignal.timeout(3_000),
  })
  expect(await response.text()).toBe('controller-local API reached')
  expect(admit).not.toHaveBeenCalled()
  expect(received).toEqual([])

  const socket = new WebSocket(`${controllerUrl.replace('http:', 'ws:')}/orchestrator/native/remote.mux`)
  cleanup.push(() => socket.terminate())
  await socketOpen(socket)
  const echoed = new Promise<unknown>((resolve, reject) => {
    socket.once('message', data => resolve(JSON.parse(data.toString()) as unknown))
    socket.once('error', reject)
  })
  socket.send(JSON.stringify({
    type: 'open',
    streamId: 'live',
    endpoint: 'terminal/attach',
    payload: { args: [{ sessionId: nativeSessionId('sglang', 'local') }] },
  }))
  expect(await echoed).toEqual({
    type: 'item',
    streamId: 'live',
    value: { echo: { args: [{ sessionId: nativeSessionId('sglang', 'local') }] } },
  })
  const controllerClosed = new Promise<void>(resolve => socket.once('close', () => resolve()))
  socket.close()
  await controllerClosed
  await localClose

  const settings = await fetch(`${controllerUrl}/api/settings/describe`, { signal: AbortSignal.timeout(3_000) })
  expect(await settings.text()).toBe('controller-local API reached')
  expect(received).toEqual([])
  expect(operatorSequence).toBe(1)
  expect(issuedOperators).toEqual(['answer'])
  expect([...operatorPeers.values()]).toEqual([])
})

it('aggregates native Sessions across every registered deployment', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-fleet-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))

  const repositories = [
    { id: 'inference-support-loop', repository: 'onenexus-team/inference-support-loop', sessionId: 'inference-session' },
    { id: 'sglang', repository: 'onenexus-team/sglang', sessionId: 'sglang-session' },
  ] as const
  const calls: { deployment: string; method: string }[] = []
  const urls: string[] = []
  for (const item of repositories) {
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/orchestrator/native/api' && !url.pathname.startsWith('/orchestrator/native/api/')) {
        response.writeHead(404).end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const envelope = JSON.parse(Buffer.concat(chunks).toString()) as {
        rpcId: string
        method: string
      }
      calls.push({ deployment: item.id, method: envelope.method })
      const value = envelope.method === 'session/list'
        ? {
            items: [{
              sessionId: item.sessionId,
              updatedAt: item.id === 'sglang' ? 2 : 1,
              running: false,
              blank: false,
              cwd: `/Users/alice/src/${item.id}`,
            }],
          }
        : undefined
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: { ok: true, value },
      }))
    })
    urls.push(await listen(server))
  }

  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: repositories.map((item, index) => ({
      ...item,
      profile: `superagent-${item.id}`,
      url: urls[index],
      stateDir: join(state, item.id),
      workspace: `/Users/alice/src/${item.id}`,
    })),
  }))
  provisionFleet(state)

  let connectionRequest: ((request: IncomingMessage, response: ServerResponse, next: () => Promise<void>) => Promise<void>) | undefined
  const controllerCtx = {
    webServer: {
      host: '127.0.0.1' as const,
      port: 0,
      register: () => () => {},
      registerUpgrade: () => () => {},
    },
    connection: { requestRejection: () => undefined, authenticatedUrl: (base: string) => `${base}/?token=test` },
    logger: { warn: vi.fn() },
    on: (_event: string, handler: NonNullable<typeof connectionRequest>) => {
      connectionRequest = handler
      return () => { connectionRequest = undefined }
    },
  }
  const dispose = registerNativeTransport(controllerCtx as never, state, 'control')
  cleanup.push(dispose)
  const server = createServer((request, response) => {
    if (connectionRequest === undefined) throw new Error('controller native HTTP interceptor is not installed')
    void connectionRequest(request, response, async () => {
      response.writeHead(500).end('controller-local API reached')
    })
  })
  const controllerUrl = await listen(server)
  controllerCtx.webServer.port = Number(new URL(controllerUrl).port)

  const response = await fetch(`${controllerUrl}/api`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'aggregate-session-list',
      method: 'session/list',
      payload: { args: {} },
    }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    type: 'server-response',
    rpcId: 'aggregate-session-list',
    result: {
      ok: true,
      value: {
        items: [
          { sessionId: nativeSessionId('sglang', 'sglang-session') },
          { sessionId: nativeSessionId('inference-support-loop', 'inference-session') },
        ],
      },
    },
  })
  expect(calls).toEqual([
    { deployment: 'inference-support-loop', method: 'session/list' },
    { deployment: 'sglang', method: 'session/list' },
  ])
})

it('aggregates Session searches within the protocol limit and reports hasMore', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-search-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))

  const loop = await peerHarness({
    stateDir: join(state, 'loop'),
    onHttp: envelope => ({
      ok: true,
      value: envelope.method === 'session/search'
        ? {
            items: Array.from({ length: 12 }, (_, index) => ({
              sessionId: `loop-${index}`,
              snippet: `loop match ${index}`,
            })),
            hasMore: false,
          }
        : undefined,
    }),
  })
  const sglang = await peerHarness({
    stateDir: join(state, 'sglang'),
    onHttp: envelope => ({
      ok: true,
      value: envelope.method === 'session/search'
        ? {
            items: Array.from({ length: 9 }, (_, index) => ({
              sessionId: `sglang-${index}`,
              snippet: `sglang match ${index}`,
            })),
            hasMore: true,
          }
        : undefined,
    }),
  })
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [
      { id: 'loop', profile: 'superagent-loop', repository: 'onenexus-team/inference-support-loop', url: loop.url,
        stateDir: join(state, 'loop'), workspace: '/tmp/loop' },
      { id: 'sglang', profile: 'superagent-sglang', repository: 'onenexus-team/sglang', url: sglang.url,
        stateDir: join(state, 'sglang'), workspace: '/tmp/sglang' },
    ],
  }))
  const controller = await controllerHarness(state)

  const response = await nativeCall(controller, 'session/search', { args: [{ query: 'match' }] })
  expect(response).toMatchObject({
    result: {
      ok: true,
      value: {
        hasMore: true,
      },
    },
  })
  const value = (response.result as { value: { items: { sessionId: string }[] } }).value
  expect(value.items).toHaveLength(20)
  expect(value.items[0]?.sessionId).toBe(nativeSessionId('loop', 'loop-0'))
  expect(value.items[11]?.sessionId).toBe(nativeSessionId('loop', 'loop-11'))
  expect(value.items[19]?.sessionId).toBe(nativeSessionId('sglang', 'sglang-7'))
  expect(loop.calls[0]?.payload).toEqual({ args: [{ query: 'match' }] })
  expect(sglang.calls[0]?.payload).toEqual({ args: [{ query: 'match' }] })
})

it('routes one scoped RPC to its owning deployment and remaps created identities', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-route-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const loop = await peerHarness({
    stateDir: join(state, 'loop'),
    onHttp: () => ({ ok: true, value: { sessionId: 'unexpected-loop' } }),
  })
  const sglang = await peerHarness({
    stateDir: join(state, 'sglang'),
    onHttp: envelope => ({
      ok: true,
      value: envelope.method === 'session/fork' ? { sessionId: 'forked-session' } : undefined,
    }),
  })
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [
      { id: 'loop', profile: 'superagent-loop', repository: 'onenexus-team/inference-support-loop', url: loop.url,
        stateDir: join(state, 'loop'), workspace: '/tmp/loop' },
      { id: 'sglang', profile: 'superagent-sglang', repository: 'onenexus-team/sglang', url: sglang.url,
        stateDir: join(state, 'sglang'), workspace: '/tmp/sglang' },
    ],
  }))
  writeFileSync(join(state, 'native-deployment.json'), JSON.stringify({ version: 1, deployment: 'loop' }))
  const controller = await controllerHarness(state)

  expect(await nativeCall(controller, 'session/fork', {
    args: [{ sessionId: nativeSessionId('sglang', 'source-session') }],
  })).toMatchObject({
    result: {
      ok: true,
      value: { sessionId: nativeSessionId('sglang', 'forked-session') },
    },
  })
  expect(loop.calls).toEqual([])
  expect(sglang.calls).toHaveLength(1)
  expect(sglang.calls[0]?.payload).toEqual({ args: [{ sessionId: 'source-session' }] })
})

it('keeps Desktop Sessions and modes on the Desktop profile while deployment Sessions stay with their deployment', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-desktop-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const sglang = await peerHarness({
    stateDir: join(state, 'sglang'),
    onHttp: envelope => ({
      ok: true,
      value: envelope.method === 'session/list'
        ? { items: [{ sessionId: 'ticket-session', updatedAt: 1, running: false, blank: false, cwd: '/tmp/sglang' }] }
        : undefined,
    }),
  })
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [{ id: 'sglang', profile: 'superagent-sglang', repository: 'onenexus-team/sglang', url: sglang.url,
      stateDir: join(state, 'sglang'), workspace: '/tmp/sglang' }],
  }))
  // The deployment selection is the Superagent management context; it no longer decides where Desktop work runs.
  writeFileSync(join(state, 'native-deployment.json'), JSON.stringify({ version: 1, deployment: 'sglang' }))
  const desktopCalls: RpcEnvelope[] = []
  const controller = await controllerHarness(state, {
    onHttp(envelope) {
      desktopCalls.push(envelope)
      if (envelope.method === 'session/create') return { ok: true, value: { sessionId: 'perfrsi-session' } }
      if (envelope.method === 'agentPresets/list') return { ok: true, value: { presets: [{ id: 'perfrsi', name: 'PerfRSI' }] } }
      if (envelope.method === 'session/list') {
        return { ok: true, value: { items: [{ sessionId: 'perfrsi-session', updatedAt: 2, running: false, blank: false, cwd: '/tmp/perf' }] } }
      }
      return { ok: true, value: null }
    },
  })

  expect(await nativeCall(controller, 'session/create', { args: [{ agentPreset: 'perfrsi' }] })).toMatchObject({
    result: { ok: true, value: { sessionId: nativeSessionId('desktop.local', 'perfrsi-session') } },
  })
  expect(await nativeCall(controller, 'agentPresets/list', { args: [] })).toMatchObject({
    result: { ok: true, value: { presets: [{ id: 'perfrsi', name: 'PerfRSI' }] } },
  })
  expect(await nativeCall(controller, 'session/list', { args: {} })).toMatchObject({
    result: {
      ok: true,
      value: {
        items: [
          { sessionId: nativeSessionId('desktop.local', 'perfrsi-session') },
          { sessionId: nativeSessionId('sglang', 'ticket-session') },
        ],
      },
    },
  })
  expect(await nativeCall(controller, 'session/rename', {
    args: [{ sessionId: nativeSessionId('desktop.local', 'perfrsi-session'), title: 'PerfRSI musespark' }],
  })).toMatchObject({ result: { ok: true } })
  expect(desktopCalls.map(call => call.method)).toEqual(['session/create', 'agentPresets/list', 'session/list', 'session/rename'])
  expect(desktopCalls[3]?.payload).toEqual({ args: [{ sessionId: 'perfrsi-session', title: 'PerfRSI musespark' }] })
  expect(sglang.calls.map(call => call.method)).toEqual(['session/list'])
})

it('routes a question answer for a Desktop Session to the Desktop profile', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-answer-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({ version: 1, deployments: [] }))
  const desktopCalls: RpcEnvelope[] = []
  const controller = await controllerHarness(state, {
    onHttp(envelope) {
      desktopCalls.push(envelope)
      return { ok: true, value: true }
    },
  })
  const answer = { answers: [{ id: 'gate_mode', selected: ['Natural gate stage + perf stage'] }] }
  expect(await nativeCall(controller, 'userQuestions/answer', {
    args: [nativeSessionId('desktop.local', 'perfrsi-session'), 'toolu_1', answer],
  })).toMatchObject({ result: { ok: true, value: true } })
  expect(desktopCalls.map(call => [call.method, call.payload])).toEqual([
    ['userQuestions/answer', { args: ['perfrsi-session', 'toolu_1', answer] }],
  ])
})

it('hides Desktop-profile copies of Sessions under a deployment state directory', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-dedupe-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const deploymentState = join(state, 'sglang')
  const sglang = await peerHarness({
    stateDir: deploymentState,
    onHttp: envelope => ({
      ok: true,
      value: envelope.method === 'session/list'
        ? { items: [{ sessionId: 'worker', updatedAt: 3, running: false, blank: false, cwd: join(deploymentState, 'work', 'sync') }] }
        : undefined,
    }),
  })
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [{ id: 'sglang', profile: 'superagent-sglang', repository: 'onenexus-team/sglang', url: sglang.url,
      stateDir: deploymentState, workspace: '/tmp/sglang' }],
  }))
  const controller = await controllerHarness(state, {
    onHttp: envelope => ({
      ok: true,
      value: envelope.method === 'session/list'
        ? { items: [
          { sessionId: 'worker', updatedAt: 1, running: false, blank: false, cwd: join(deploymentState, 'work', 'sync') },
          { sessionId: 'perfrsi', updatedAt: 2, running: false, blank: false, cwd: '/tmp/perf' },
        ] }
        : null,
    }),
  })

  const response = await nativeCall(controller, 'session/list', { args: {} })
  const items = (response.result as { value: { items: { sessionId: string }[] } }).value.items
  expect(items.map(item => item.sessionId)).toEqual([
    nativeSessionId('sglang', 'worker'),
    nativeSessionId('desktop.local', 'perfrsi'),
  ])
})

it('answers the Desktop welcome settings read from the Desktop profile', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-welcome-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({ version: 1, deployments: [] }))
  const controller = await controllerHarness(state, {
    onHttp: envelope => ({ ok: true, value: envelope.method === 'settings/describe' ? { namespaces: [] } : null }),
  })
  const response = await fetch(`${controller}/api/settings/describe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'welcome', method: 'settings/describe', payload: { args: {} } }),
  })
  expect(await response.json()).toEqual({
    type: 'server-response',
    rpcId: 'welcome',
    result: { ok: true, value: { namespaces: [] } },
  })
})

it('prefixes both Session and Workspace titles in unary rename responses', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-rename-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const sglang = await peerHarness({
    stateDir: join(state, 'sglang'),
    onHttp: envelope => ({
      ok: true,
      value: envelope.method === 'session/rename'
        ? { title: 'Renamed Session', seq: 4 }
        : envelope.method === 'workspace/rename'
          ? { title: 'Renamed Workspace' }
          : undefined,
    }),
  })
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [{
      id: 'sglang',
      profile: 'superagent-sglang',
      repository: 'onenexus-team/sglang',
      url: sglang.url,
      stateDir: join(state, 'sglang'),
      workspace: '/tmp/sglang',
    }],
  }))
  const controller = await controllerHarness(state)

  expect(await nativeCall(controller, 'session/rename', {
    args: [{
      sessionId: nativeSessionId('sglang', 'session'),
      title: 'onenexus-team/sglang · Renamed Session',
    }],
  })).toMatchObject({
    result: {
      ok: true,
      value: {
        title: 'onenexus-team/sglang · Renamed Session',
        seq: 4,
      },
    },
  })
  expect(await nativeCall(controller, 'workspace/rename', {
    args: [{
      workspaceId: nativeWorkspaceId('sglang', 'workspace'),
      title: 'onenexus-team/sglang · Renamed Workspace',
    }],
  })).toMatchObject({
    result: {
      ok: true,
      value: {
        title: 'onenexus-team/sglang · Renamed Workspace',
      },
    },
  })
  expect(sglang.calls[0]?.payload).toEqual({
    args: [{ sessionId: 'session', title: 'Renamed Session' }],
  })
  expect(sglang.calls[1]?.payload).toEqual({
    args: [{ workspaceId: 'workspace', title: 'Renamed Workspace' }],
  })
})

it('rejects mixed-owner and unknown-owner requests before contacting a deployment', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-owner-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const loop = await peerHarness({ stateDir: join(state, 'loop') })
  const sglang = await peerHarness({ stateDir: join(state, 'sglang') })
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [
      { id: 'loop', profile: 'superagent-loop', repository: 'onenexus-team/inference-support-loop', url: loop.url,
        stateDir: join(state, 'loop'), workspace: '/tmp/loop' },
      { id: 'sglang', profile: 'superagent-sglang', repository: 'onenexus-team/sglang', url: sglang.url,
        stateDir: join(state, 'sglang'), workspace: '/tmp/sglang' },
    ],
  }))
  const controller = await controllerHarness(state)

  expect(await nativeCall(controller, 'workspace/rename', {
    args: [{
      workspaceId: nativeWorkspaceId('loop', 'workspace'),
      sessionId: nativeSessionId('sglang', 'session'),
      title: 'mixed',
    }],
  })).toMatchObject({
    result: { ok: false, error: { code: 'gateway/bad-request', message: expect.stringContaining('spans multiple deployments') } },
  })
  expect(await nativeCall(controller, 'session/cancel', {
    args: [{ sessionId: nativeSessionId('missing', 'session') }],
  })).toMatchObject({
    result: { ok: false, error: { code: 'gateway/bad-request', message: expect.stringContaining('unknown deployment') } },
  })
  expect(loop.calls).toEqual([])
  expect(sglang.calls).toEqual([])
})

it('keeps available Sessions visible when another peer cannot answer', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-partial-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const loop = await peerHarness({
    stateDir: join(state, 'loop'),
    onHttp: envelope => ({
      ok: true,
      value: envelope.method === 'session/list'
        ? { items: [{ sessionId: 'loop-session', updatedAt: 1, running: false, blank: false }] }
        : undefined,
    }),
  })
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [
      { id: 'loop', profile: 'superagent-loop', repository: 'onenexus-team/inference-support-loop', url: loop.url,
        stateDir: join(state, 'loop'), workspace: '/tmp/loop' },
      { id: 'offline', profile: 'superagent-offline', repository: 'onenexus-team/offline', url: 'http://127.0.0.1:9',
        stateDir: join(state, 'offline'), workspace: '/tmp/offline' },
    ],
  }))
  const controller = await controllerHarness(state)

  expect(await nativeCall(controller, 'session/list', { args: [{}] })).toMatchObject({
    result: {
      ok: true,
      value: {
        items: [{ sessionId: nativeSessionId('loop', 'loop-session') }],
      },
    },
  })
})

it('bounds a hung peer request while returning the responsive peer Sessions', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-hung-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const loop = await peerHarness({
    stateDir: join(state, 'loop'),
    onHttp: envelope => ({
      ok: true,
      value: envelope.method === 'session/list'
        ? { items: [{ sessionId: 'loop-session', updatedAt: 1, running: false, blank: false }] }
        : undefined,
    }),
  })
  const hung = createServer(() => {})
  const hungUrl = await listen(hung)
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [
      { id: 'loop', profile: 'superagent-loop', repository: 'onenexus-team/inference-support-loop', url: loop.url,
        stateDir: join(state, 'loop'), workspace: '/tmp/loop' },
      { id: 'hung', profile: 'superagent-hung', repository: 'onenexus-team/hung', url: hungUrl,
        stateDir: join(state, 'hung'), workspace: '/tmp/hung' },
    ],
  }))
  const controller = await controllerHarness(state)
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds =>
    originalTimeout(Math.min(milliseconds, 100)))
  try {
    expect(await nativeCall(controller, 'session/list', { args: [{}] })).toMatchObject({
      result: {
        ok: true,
        value: {
          items: [{ sessionId: nativeSessionId('loop', 'loop-session') }],
        },
      },
    })
  } finally {
    timeout.mockRestore()
  }
})

it('aggregates Workspace baselines and ordered archive, pin, upsert, and removal frames', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-workspaces-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const loop = await peerHarness({
    stateDir: join(state, 'loop'),
    onStream(request, send) {
      if (request.endpoint !== 'workspace/follow') return
      send({
        type: 'baseline',
        value: {
          items: [{
            workspaceId: 'loop-workspace',
            path: '/tmp/loop',
            title: 'Release support',
            sessionIds: ['loop-session'],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          }],
          archivedSessionIds: ['loop-archived'],
          pinnedSessionIds: ['loop-pinned'],
        },
      })
    },
  })
  const sglang = await peerHarness({
    stateDir: join(state, 'sglang'),
    onStream(request, send) {
      if (request.endpoint !== 'workspace/follow') return
      send({
        type: 'baseline',
        value: {
          items: [{
            workspaceId: 'sglang-workspace',
            path: '/tmp/sglang',
            title: 'SGLang',
            sessionIds: ['sglang-session'],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          }],
          archivedSessionIds: ['sglang-archived'],
          pinnedSessionIds: ['sglang-pinned'],
        },
      })
      setTimeout(() => {
        send({
          type: 'upsert',
          workspace: {
            workspaceId: 'sglang-new',
            path: '/tmp/sglang-new',
            title: 'Upstream sync',
            sessionIds: ['sglang-new-session'],
            createdAt: '2026-01-02T00:00:00Z',
            updatedAt: '2026-01-02T00:00:00Z',
          },
        })
        send({ type: 'order', workspaceIds: ['sglang-new', 'sglang-workspace'] })
        send({ type: 'archived', archivedSessionIds: ['sglang-new-archived'] })
        send({ type: 'pinned', pinnedSessionIds: ['sglang-new-pinned'] })
        send({ type: 'remove', workspaceId: 'sglang-new' })
      }, 50)
    },
  })
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [
      { id: 'loop', profile: 'superagent-loop', repository: 'onenexus-team/inference-support-loop', url: loop.url,
        stateDir: join(state, 'loop'), workspace: '/tmp/loop' },
      { id: 'sglang', profile: 'superagent-sglang', repository: 'onenexus-team/sglang', url: sglang.url,
        stateDir: join(state, 'sglang'), workspace: '/tmp/sglang' },
    ],
  }))
  const controller = await controllerHarness(state)
  const { socket, next } = await openMux(controller)
  socket.send(JSON.stringify({
    type: 'open',
    streamId: 'workspaces',
    endpoint: 'workspace/follow',
    payload: { args: [] },
  }))

  expect(await next()).toMatchObject({
    type: 'item',
    streamId: 'workspaces',
    value: {
      type: 'baseline',
      value: {
        items: [
          {
            workspaceId: nativeWorkspaceId('loop', 'loop-workspace'),
            title: 'onenexus-team/inference-support-loop · Release support',
            sessionIds: [nativeSessionId('loop', 'loop-session')],
          },
          {
            workspaceId: nativeWorkspaceId('sglang', 'sglang-workspace'),
            title: 'onenexus-team/sglang · SGLang',
            sessionIds: [nativeSessionId('sglang', 'sglang-session')],
          },
        ],
        archivedSessionIds: [
          nativeSessionId('loop', 'loop-archived'),
          nativeSessionId('sglang', 'sglang-archived'),
        ],
        pinnedSessionIds: [
          nativeSessionId('loop', 'loop-pinned'),
          nativeSessionId('sglang', 'sglang-pinned'),
        ],
      },
    },
  })
  expect(await next()).toMatchObject({
    value: {
      type: 'upsert',
      workspace: {
        workspaceId: nativeWorkspaceId('sglang', 'sglang-new'),
        title: 'onenexus-team/sglang · Upstream sync',
      },
    },
  })
  expect(await next()).toMatchObject({
    value: {
      type: 'order',
      workspaceIds: [
        nativeWorkspaceId('loop', 'loop-workspace'),
        nativeWorkspaceId('sglang', 'sglang-new'),
        nativeWorkspaceId('sglang', 'sglang-workspace'),
      ],
    },
  })
  expect(await next()).toMatchObject({
    value: {
      type: 'archived',
      archivedSessionIds: [
        nativeSessionId('loop', 'loop-archived'),
        nativeSessionId('sglang', 'sglang-new-archived'),
      ],
    },
  })
  expect(await next()).toMatchObject({
    value: {
      type: 'pinned',
      pinnedSessionIds: [
        nativeSessionId('loop', 'loop-pinned'),
        nativeSessionId('sglang', 'sglang-new-pinned'),
      ],
    },
  })
  expect(await next()).toMatchObject({
    value: {
      type: 'remove',
      workspaceId: nativeWorkspaceId('sglang', 'sglang-new'),
    },
  })

  sglang.calls.length = 0
  await nativeCall(controller, 'workspace/rename', {
      args: [{
        workspaceId: nativeWorkspaceId('sglang', 'sglang-workspace'),
        title: 'onenexus-team/sglang · Renamed',
      }],
  })
  expect(sglang.calls[0]?.payload).toEqual({
    args: [{ workspaceId: 'sglang-workspace', title: 'Renamed' }],
  })
})

it('aggregates Session-control projections and routes Session-follow snapshots by aggregate id', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-control-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const loop = await peerHarness({
    stateDir: join(state, 'loop'),
    onStream(request, send) {
      if (request.endpoint === 'session/control') {
        send({
          type: 'baseline',
          value: {
            projections: {
              'loop-session': {
                asOfSeq: 4,
                values: { title: 'Loop review', modelSelection: { next: null } },
              },
            },
          },
        })
        return
      }
      if (request.endpoint === 'session/follow') {
        send({
          type: 'snapshot',
          header: {
            version: 1,
            id: 'loop-session',
            parentSession: 'loop-parent',
            createdAt: 1,
            isSeeded: false,
          },
          cursor: 4,
          records: [],
          hasMore: false,
          projections: {
            asOfSeq: 4,
            values: {
              title: 'Loop review',
              subagentCatalog: [{ id: 'loop-child' }],
            },
          },
        })
      }
    },
  })
  const sglang = await peerHarness({
    stateDir: join(state, 'sglang'),
    onStream(request, send) {
      if (request.endpoint !== 'session/control') return
      send({
        type: 'baseline',
        value: {
          projections: {
            'sglang-session': {
              asOfSeq: 7,
              values: { title: 'SGLang review', modelSelection: { next: null } },
            },
          },
        },
      })
      setTimeout(() => send({
        type: 'projection',
        sessionId: 'sglang-session',
        key: 'title',
        value: 'SGLang updated',
        seq: 8,
      }), 50)
    },
  })
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [
      { id: 'loop', profile: 'superagent-loop', repository: 'onenexus-team/inference-support-loop', url: loop.url,
        stateDir: join(state, 'loop'), workspace: '/tmp/loop' },
      { id: 'sglang', profile: 'superagent-sglang', repository: 'onenexus-team/sglang', url: sglang.url,
        stateDir: join(state, 'sglang'), workspace: '/tmp/sglang' },
    ],
  }))
  const controller = await controllerHarness(state)
  const { socket, next } = await openMux(controller)
  socket.send(JSON.stringify({
    type: 'open',
    streamId: 'control',
    endpoint: 'session/control',
    payload: { args: [] },
  }))
  expect(await next()).toMatchObject({
    value: {
      type: 'baseline',
      value: {
        projections: {
          [nativeSessionId('loop', 'loop-session')]: {
            asOfSeq: 4,
            values: { title: 'onenexus-team/inference-support-loop · Loop review' },
          },
          [nativeSessionId('sglang', 'sglang-session')]: {
            asOfSeq: 7,
            values: { title: 'onenexus-team/sglang · SGLang review' },
          },
        },
      },
    },
  })
  expect(await next()).toMatchObject({
    value: {
      type: 'projection',
      sessionId: nativeSessionId('sglang', 'sglang-session'),
      key: 'title',
      value: 'onenexus-team/sglang · SGLang updated',
      seq: 8,
    },
  })

  socket.send(JSON.stringify({
    type: 'open',
    streamId: 'follow',
    endpoint: 'session/follow',
    payload: {
      args: [{
        address: { kind: 'session', sessionId: nativeSessionId('loop', 'loop-session') },
        assistantStream: true,
      }],
    },
  }))
  expect(await next()).toMatchObject({
    type: 'item',
    streamId: 'follow',
    value: {
      type: 'snapshot',
      header: {
        id: nativeSessionId('loop', 'loop-session'),
        parentSession: nativeSessionId('loop', 'loop-parent'),
      },
      projections: {
        values: {
          title: 'onenexus-team/inference-support-loop · Loop review',
          subagentCatalog: [{ id: nativeSessionId('loop', 'loop-child') }],
        },
      },
    },
  })
  expect(loop.streamRequests.at(-1)).toMatchObject({
    endpoint: 'session/follow',
    payload: {
      args: [{
        address: { kind: 'session', sessionId: 'loop-session' },
      }],
    },
  })
})

it('applies a later Session-control baseline as projection updates after the aggregate snapshot', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-late-control-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const loop = await peerHarness({
    stateDir: join(state, 'loop'),
    onStream(request, send) {
      if (request.endpoint !== 'session/control') return
      send({
        type: 'baseline',
        value: { projections: { 'loop-session': { asOfSeq: 1, values: { title: 'Initial' } } } },
      })
      setTimeout(() => send({
        type: 'baseline',
        value: {
          projections: {
            // No committed event yet: a projection frame cannot carry its seq, so it sends nothing.
            'blank-session': { asOfSeq: -1, values: { title: 'Blank' } },
            'loop-session': { asOfSeq: 5, values: { title: 'Later baseline' } },
            'late-session': { asOfSeq: 4, values: { title: 'Late Session' } },
          },
        },
      }), 50)
    },
  })
  const sglang = await peerHarness({
    stateDir: join(state, 'sglang'),
    onStream(request, send) {
      if (request.endpoint !== 'session/control') return
      send({
        type: 'baseline',
        value: { projections: { 'sglang-session': { asOfSeq: 2, values: { title: 'SGLang' } } } },
      })
    },
  })
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [
      { id: 'loop', profile: 'superagent-loop', repository: 'onenexus-team/inference-support-loop', url: loop.url,
        stateDir: join(state, 'loop'), workspace: '/tmp/loop' },
      { id: 'sglang', profile: 'superagent-sglang', repository: 'onenexus-team/sglang', url: sglang.url,
        stateDir: join(state, 'sglang'), workspace: '/tmp/sglang' },
    ],
  }))
  const controller = await controllerHarness(state)
  const { socket, next } = await openMux(controller)
  socket.send(JSON.stringify({
    type: 'open',
    streamId: 'control',
    endpoint: 'session/control',
    payload: { args: [] },
  }))

  expect(await next()).toMatchObject({
    value: {
      type: 'baseline',
      value: {
        projections: {
          [nativeSessionId('loop', 'loop-session')]: { values: { title: 'onenexus-team/inference-support-loop · Initial' } },
          [nativeSessionId('sglang', 'sglang-session')]: { values: { title: 'onenexus-team/sglang · SGLang' } },
        },
      },
    },
  })

  const updates = [await next(), await next()]
  expect(updates).toEqual(expect.arrayContaining([
    expect.objectContaining({
      value: {
        type: 'projection',
        sessionId: nativeSessionId('loop', 'loop-session'),
        seq: 5,
        changes: [{ key: 'title', val: 'onenexus-team/inference-support-loop · Later baseline' }],
      },
    }),
    expect.objectContaining({
      value: {
        type: 'projection',
        sessionId: nativeSessionId('loop', 'late-session'),
        seq: 4,
        changes: [{ key: 'title', val: 'onenexus-team/inference-support-loop · Late Session' }],
      },
    }),
  ]))
})

it('merges Session events, takes global events only from the Desktop profile, and correlates waterfall results', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-events-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  let loopEventGeneration = 0
  const loop = await peerHarness({
    stateDir: join(state, 'loop'),
    onStream(request, send) {
      if (request.endpoint !== '$events') return
      const clientId = `loop-event-client-${++loopEventGeneration}`
      send({ type: 'ready', clientId, host: { home: '/Users/alice' } })
      send({ type: 'emit', event: 'agent-preset/selected', args: ['loop-session', 'worker'] })
      send({ type: 'emit', event: 'settings/document-updated', args: ['loop-settings'] })
      send({
        type: 'waterfall',
        event: 'approval/request',
        eventId: 'loop-approval',
        agentId: 'loop-session',
        request: { reason: 'write file' },
      })
    },
  })
  const sglang = await peerHarness({
    stateDir: join(state, 'sglang'),
    onStream(request, send) {
      if (request.endpoint !== '$events') return
      send({ type: 'ready', clientId: 'sglang-event-client', host: { home: '/Users/alice' } })
      send({ type: 'emit', event: 'api-session/status', args: ['sglang-session', true] })
      send({ type: 'emit', event: 'settings/document-updated', args: ['sglang-settings'] })
    },
  })
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [
      { id: 'loop', profile: 'superagent-loop', repository: 'onenexus-team/inference-support-loop', url: loop.url,
        stateDir: join(state, 'loop'), workspace: '/tmp/loop' },
      { id: 'sglang', profile: 'superagent-sglang', repository: 'onenexus-team/sglang', url: sglang.url,
        stateDir: join(state, 'sglang'), workspace: '/tmp/sglang' },
    ],
  }))
  writeFileSync(join(state, 'native-deployment.json'), JSON.stringify({ version: 1, deployment: 'loop' }))
  const controller = await controllerHarness(state, {
    onStream(request, send) {
      if (request.endpoint !== '$events') return
      send({ type: 'ready', clientId: 'desktop-event-client', host: { home: '/Users/alice' } })
      send({ type: 'emit', event: 'settings/document-updated', args: ['desktop-settings'] })
    },
  })
  const { socket, next } = await openMux(controller)
  socket.send(JSON.stringify({
    type: 'open',
    streamId: 'events',
    endpoint: '$events',
    payload: { args: {} },
  }))

  const ready = await next()
  expect(ready).toMatchObject({ type: 'item', streamId: 'events', value: { type: 'ready' } })
  const controllerClientId = (ready.value as { clientId: string }).clientId
  expect(controllerClientId).toMatch(/^dsh-superagent\.events\./)

  const events: Record<string, unknown>[] = []
  for (let index = 0; events.length < 3 && index < 8; index++) {
    const frame = await next()
    if ((frame.value as { type?: string } | undefined)?.type === 'emit') events.push(frame)
  }
  expect(events).toEqual(expect.arrayContaining([
    {
      type: 'item',
      streamId: 'events',
      value: {
        type: 'emit',
        event: 'agent-preset/selected',
        args: [nativeSessionId('loop', 'loop-session'), 'worker'],
      },
    },
    {
      type: 'item',
      streamId: 'events',
      value: {
        type: 'emit',
        event: 'api-session/status',
        args: [nativeSessionId('sglang', 'sglang-session'), true],
      },
    },
    {
      type: 'item',
      streamId: 'events',
      value: {
        type: 'emit',
        event: 'settings/document-updated',
        args: ['desktop-settings'],
      },
    },
  ]))
  expect(events.flatMap(frame => {
    const value = frame.value as { event?: string; args?: unknown[] }
    return value.event === 'settings/document-updated' ? value.args ?? [] : []
  })).toEqual(['desktop-settings'])

  socket.send(JSON.stringify({
    type: 'open',
    streamId: 'approval-events',
    endpoint: '$events',
    payload: { args: {} },
  }))
  const secondReady = await next()
  expect(secondReady).toMatchObject({ type: 'item', streamId: 'approval-events', value: { type: 'ready' } })
  const secondClientId = (secondReady.value as { clientId: string }).clientId

  let approval: Record<string, unknown> | undefined
  for (let index = 0; index < 6; index++) {
    const frame = await next()
    if ((frame.value as { type?: string } | undefined)?.type === 'waterfall') {
      approval = frame
      break
    }
  }
  expect(approval).toMatchObject({
    type: 'item',
    streamId: 'approval-events',
    value: {
      type: 'waterfall',
      event: 'approval/request',
      eventId: nativeEventId('loop', 'loop-approval'),
      agentId: nativeSessionId('loop', 'loop-session'),
      request: { reason: 'write file' },
    },
  })
  await nativeCall(controller, '$events/result', {
    args: [{
      clientId: controllerClientId,
      eventId: nativeEventId('loop', 'loop-approval'),
      outcome: { kind: 'next' },
    }],
  })
  await nativeCall(controller, '$events/result', {
    args: [{
      clientId: secondClientId,
      eventId: nativeEventId('loop', 'loop-approval'),
      outcome: { kind: 'next' },
    }],
  })
  expect(loop.calls).toHaveLength(2)
  expect(loop.calls[0]?.payload).toEqual({
    args: [{
      clientId: 'loop-event-client-1',
      eventId: 'loop-approval',
      outcome: { kind: 'next' },
    }],
  })
  expect(loop.calls[1]?.payload).toEqual({
    args: [{
      clientId: 'loop-event-client-2',
      eventId: 'loop-approval',
      outcome: { kind: 'next' },
    }],
  })
  expect(sglang.calls).toEqual([])

  socket.send(JSON.stringify({ type: 'cancel', streamId: 'events' }))
  await vi.waitFor(async () => {
    expect(await nativeCall(controller, '$events/result', {
      args: [{
        clientId: controllerClientId,
        eventId: nativeEventId('loop', 'loop-approval'),
        outcome: { kind: 'next' },
      }],
    })).toMatchObject({
      result: {
        ok: false,
        error: { code: 'gateway/internal', message: expect.stringContaining('Remote event stream is unavailable') },
      },
    })
  })
})

it('reconnects the aggregate carrier when a remote Session history stream restarts', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-session-restart-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const sglang = await peerHarness({
    stateDir: join(state, 'sglang'),
    onStream(request, send) {
      if (request.endpoint !== 'session/follow') return
      send({
        type: 'snapshot',
        header: { version: 1, id: 'sglang-session', createdAt: 1, isSeeded: false },
        cursor: 1,
        records: [],
        hasMore: false,
        projections: { asOfSeq: 1, values: { title: 'SGLang history' } },
      })
    },
  })
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [{
      id: 'sglang',
      profile: 'superagent-sglang',
      repository: 'onenexus-team/sglang',
      url: sglang.url,
      stateDir: join(state, 'sglang'),
      workspace: '/tmp/sglang',
    }],
  }))
  const controller = await controllerHarness(state)
  const { socket, next } = await openMux(controller)
  socket.send(JSON.stringify({
    type: 'open',
    streamId: 'history',
    endpoint: 'session/follow',
    payload: {
      args: [{
        address: { kind: 'session', sessionId: nativeSessionId('sglang', 'sglang-session') },
        assistantStream: true,
      }],
    },
  }))
  expect(await next()).toMatchObject({
    type: 'item',
    streamId: 'history',
    value: { type: 'snapshot', header: { id: nativeSessionId('sglang', 'sglang-session') } },
  })

  const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Controller carrier remained open')), 3_000)
    socket.once('close', (code, reason) => {
      clearTimeout(timer)
      resolve({ code, reason: reason.toString() })
    })
  })
  await sglang.stop()
  expect(await closed).toEqual({ code: 1012, reason: 'Deployment Session stream lost' })
})

it('keeps Desktop Workspace, control, and event streams open when every deployment is offline', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-no-streams-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [{
      id: 'offline',
      profile: 'superagent-offline',
      repository: 'onenexus-team/offline',
      url: 'http://127.0.0.1:9',
      stateDir: join(state, 'offline'),
      workspace: '/tmp/offline',
    }],
  }))
  const controller = await controllerHarness(state)

  for (const [streamId, endpoint, baseline] of [
    ['workspace', 'workspace/follow', { items: [], archivedSessionIds: [], pinnedSessionIds: [] }],
    ['control', 'session/control', { projections: {} }],
  ] as const) {
    const { socket, next } = await openMux(controller)
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args: [] } }))
    expect(await next()).toMatchObject({ type: 'item', streamId, value: { type: 'baseline', value: baseline } })
  }

  const { socket, next } = await openMux(controller)
  socket.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }))
  expect(await next()).toMatchObject({ type: 'item', streamId: 'events', value: { type: 'ready' } })
  socket.send(JSON.stringify({ type: 'cancel', streamId: 'events' }))
})

it('adds a deployment that starts after the Workspace, control, and event streams opened', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-late-start-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const port = await freePort()
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [{ id: 'sglang', profile: 'superagent-sglang', repository: 'onenexus-team/sglang',
      url: `http://127.0.0.1:${port}`, stateDir: join(state, 'sglang'), workspace: '/tmp/sglang' }],
  }))
  const controller = await controllerHarness(state)
  const workspaces = await openMux(controller)
  workspaces.socket.send(JSON.stringify({ type: 'open', streamId: 'workspaces', endpoint: 'workspace/follow', payload: { args: [] } }))
  expect(await workspaces.next()).toMatchObject({ value: { type: 'baseline', value: { items: [] } } })
  const control = await openMux(controller)
  control.socket.send(JSON.stringify({ type: 'open', streamId: 'control', endpoint: 'session/control', payload: { args: [] } }))
  expect(await control.next()).toMatchObject({ value: { type: 'baseline', value: { projections: {} } } })
  const events = await openMux(controller)
  events.socket.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }))
  const ready = await events.next()
  expect(ready).toMatchObject({ value: { type: 'ready' } })
  const controllerClientId = (ready.value as { clientId: string }).clientId

  // The deployment starts only now, as when the operator starts it after Desktop opened following a reboot.
  const sglang = await peerHarness({
    stateDir: join(state, 'sglang'),
    port,
    onStream(request, send) {
      if (request.endpoint === 'workspace/follow') {
        send({
          type: 'baseline',
          value: {
            items: [{
              workspaceId: 'sglang-workspace',
              path: '/tmp/sglang',
              title: 'SGLang',
              sessionIds: ['sglang-session'],
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            }],
            archivedSessionIds: [],
            pinnedSessionIds: [],
          },
        })
      } else if (request.endpoint === 'session/control') {
        send({ type: 'baseline', value: { projections: { 'sglang-session': { asOfSeq: 2, values: { title: 'SGLang' } } } } })
      } else if (request.endpoint === '$events') {
        send({ type: 'ready', clientId: 'sglang-event-client', host: { home: '/Users/alice' } })
        send({ type: 'emit', event: 'api-session/status', args: ['sglang-session', true] })
      }
    },
  })

  expect(await workspaces.next()).toMatchObject({
    value: {
      type: 'replace',
      value: {
        items: [{
          workspaceId: nativeWorkspaceId('sglang', 'sglang-workspace'),
          title: 'onenexus-team/sglang · SGLang',
          sessionIds: [nativeSessionId('sglang', 'sglang-session')],
        }],
      },
    },
  })
  expect(await control.next()).toMatchObject({
    value: {
      type: 'projection',
      sessionId: nativeSessionId('sglang', 'sglang-session'),
      seq: 2,
      changes: [{ key: 'title', val: 'onenexus-team/sglang · SGLang' }],
    },
  })
  expect(await events.next()).toMatchObject({
    value: { type: 'emit', event: 'api-session/status', args: [nativeSessionId('sglang', 'sglang-session'), true] },
  })
  await nativeCall(controller, '$events/result', {
    args: [{ clientId: controllerClientId, eventId: nativeEventId('sglang', 'sglang-approval'), outcome: { kind: 'next' } }],
  })
  expect(sglang.calls.map(call => call.payload)).toEqual([{
    args: [{ clientId: 'sglang-event-client', eventId: 'sglang-approval', outcome: { kind: 'next' } }],
  }])
})

it('resubscribes a restarted deployment and replaces its Workspaces', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-restart-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const workspaceStream = (id: string, title: string) => (request: StreamRequest, send: (value: unknown) => void): void => {
    if (request.endpoint !== 'workspace/follow') return
    send({
      type: 'baseline',
      value: {
        items: [{
          workspaceId: id,
          path: `/tmp/${id}`,
          title,
          sessionIds: [`${id}-session`],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        }],
        archivedSessionIds: [],
        pinnedSessionIds: [],
      },
    })
  }
  const before = await peerHarness({ stateDir: join(state, 'sglang'), onStream: workspaceStream('before', 'Before restart') })
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [{ id: 'sglang', profile: 'superagent-sglang', repository: 'onenexus-team/sglang',
      url: before.url, stateDir: join(state, 'sglang'), workspace: '/tmp/sglang' }],
  }))
  const controller = await controllerHarness(state)
  const { socket, next } = await openMux(controller)
  socket.send(JSON.stringify({ type: 'open', streamId: 'workspaces', endpoint: 'workspace/follow', payload: { args: [] } }))
  expect(await next()).toMatchObject({
    value: { type: 'baseline', value: { items: [{ workspaceId: nativeWorkspaceId('sglang', 'before') }] } },
  })

  await before.stop()
  await peerHarness({
    stateDir: join(state, 'sglang'),
    port: Number(new URL(before.url).port),
    onStream: workspaceStream('after', 'After restart'),
  })

  expect(await next()).toMatchObject({
    value: {
      type: 'replace',
      value: { items: [{ workspaceId: nativeWorkspaceId('sglang', 'after'), title: 'onenexus-team/sglang · After restart' }] },
    },
  })
})

it('routes interactive terminal streams and their uplink frames to the Session owner', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-terminal-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const loop = await peerHarness({ stateDir: join(state, 'loop') })
  const sglang = await peerHarness({
    stateDir: join(state, 'sglang'),
    onStream(request, send) {
      if (request.endpoint === 'terminal/attach') send({ kind: 'ready', terminalId: 'terminal-1' })
    },
  })
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [
      { id: 'loop', profile: 'superagent-loop', repository: 'onenexus-team/inference-support-loop', url: loop.url,
        stateDir: join(state, 'loop'), workspace: '/tmp/loop' },
      { id: 'sglang', profile: 'superagent-sglang', repository: 'onenexus-team/sglang', url: sglang.url,
        stateDir: join(state, 'sglang'), workspace: '/tmp/sglang' },
    ],
  }))
  writeFileSync(join(state, 'native-deployment.json'), JSON.stringify({ version: 1, deployment: 'loop' }))
  const controller = await controllerHarness(state)
  const { socket, next } = await openMux(controller)
  socket.send(JSON.stringify({
    type: 'open',
    streamId: 'terminal',
    endpoint: 'terminal/attach',
    payload: {
      args: [{ sessionId: nativeSessionId('sglang', 'sglang-session'), terminalId: 'terminal-1' }],
    },
  }))
  expect(await next()).toMatchObject({
    type: 'item',
    streamId: 'terminal',
    value: { kind: 'ready', terminalId: 'terminal-1' },
  })
  expect(sglang.streamRequests.at(-1)?.payload).toEqual({
    args: [{ sessionId: 'sglang-session', terminalId: 'terminal-1' }],
  })
  expect(loop.streamRequests).toEqual([])

  socket.send(JSON.stringify({ type: 'item', streamId: 'terminal', value: { data: 'pnpm test\n' } }))
  await vi.waitFor(() => expect(sglang.uplinks).toContainEqual({
    type: 'item',
    streamId: sglang.streamRequests.at(-1)?.streamId,
    value: { data: 'pnpm test\n' },
  }))
  socket.send(JSON.stringify({ type: 'end', streamId: 'terminal' }))
  await vi.waitFor(() => expect(sglang.uplinks).toContainEqual({
    type: 'end',
    streamId: sglang.streamRequests.at(-1)?.streamId,
  }))
})

it('rejects duplicate stream ids and propagates cancellation to the owning upstream', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-cancel-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const sglang = await peerHarness({
    stateDir: join(state, 'sglang'),
    onStream(request, send) {
      if (request.endpoint === 'terminal/attach') send({ kind: 'ready', terminalId: 'terminal-1' })
      if (request.endpoint === 'workspace/follow') {
        send({
          type: 'baseline',
          value: {
            items: [{
              workspaceId: 'workspace',
              path: '/tmp/sglang',
              title: 'SGLang',
              sessionIds: ['session'],
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            }],
            archivedSessionIds: [],
            pinnedSessionIds: [],
          },
        })
      }
    },
  })
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [{
      id: 'sglang',
      profile: 'superagent-sglang',
      repository: 'onenexus-team/sglang',
      url: sglang.url,
      stateDir: join(state, 'sglang'),
      workspace: '/tmp/sglang',
    }],
  }))
  const controller = await controllerHarness(state)
  const { socket, next } = await openMux(controller)
  const open = {
    type: 'open',
    streamId: 'terminal',
    endpoint: 'terminal/attach',
    payload: { args: [{ sessionId: nativeSessionId('sglang', 'session'), terminalId: 'terminal-1' }] },
  }
  socket.send(JSON.stringify(open))
  expect(await next()).toMatchObject({
    type: 'item',
    streamId: 'terminal',
    value: { kind: 'ready', terminalId: 'terminal-1' },
  })
  expect(sglang.streamRequests).toHaveLength(1)

  socket.send(JSON.stringify(open))
  expect(await next()).toMatchObject({
    type: 'error',
    streamId: 'terminal',
    error: { code: 'gateway/protocol', message: 'Remote stream id is already open' },
  })
  expect(await next()).toMatchObject({ type: 'end', streamId: 'terminal' })
  expect(sglang.streamRequests).toHaveLength(1)

  socket.send(JSON.stringify({ type: 'cancel', streamId: 'terminal' }))
  await vi.waitFor(() => expect(sglang.uplinks).toContainEqual({
    type: 'cancel',
    streamId: sglang.streamRequests[0]?.streamId,
  }))

  const workspace = await openMux(controller)
  workspace.socket.send(JSON.stringify({
    type: 'open',
    streamId: 'workspace',
    endpoint: 'workspace/follow',
    payload: { args: [] },
  }))
  expect(await workspace.next()).toMatchObject({
    type: 'item',
    streamId: 'workspace',
    value: {
      type: 'baseline',
      value: {
        items: [{
          workspaceId: nativeWorkspaceId('sglang', 'workspace'),
          sessionIds: [nativeSessionId('sglang', 'session')],
        }],
      },
    },
  })
  const workspaceUpstream = sglang.streamRequests.at(-1)!.streamId
  workspace.socket.send(JSON.stringify({ type: 'cancel', streamId: 'workspace' }))
  await vi.waitFor(() => expect(sglang.uplinks).toContainEqual({
    type: 'cancel',
    streamId: workspaceUpstream,
  }))
})

it('refuses repository proxy traffic that lacks the controller capability', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-auth-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  let health: Handler | undefined
  let upgrade: UpgradeHandler | undefined
  const authenticatedFetch = vi.fn()
  const authenticate = vi.fn()
  const ctx = {
    webServer: {
      host: '127.0.0.1',
      port: 3083,
      register: (route: { handler: Handler }) => {
        health = route.handler
        return () => { health = undefined }
      },
      registerUpgrade: (route: { handler: UpgradeHandler }) => {
        upgrade = route.handler
        return () => { upgrade = undefined }
      },
    },
    connection: {
      createSharedFetchHandler: () => ({
        requestBodyMode: () => 'buffered',
        fetch: authenticatedFetch,
      }),
      authenticatedUrl: () => {
        authenticate()
        return 'http://127.0.0.1:3083/?token=test'
      },
    },
    logger: { warn: vi.fn() },
  }
  const dispose = registerNativeTransport(ctx as never, state, 'repository')
  cleanup.push(dispose)

  const server = createServer((request, response) => {
    if (health === undefined) throw new Error('repository native HTTP route is not installed')
    void health(request, response)
  })
  server.on('upgrade', (request, socket, head) => {
    if (upgrade === undefined) throw new Error('repository native upgrade route is not installed')
    upgrade(request, socket, head)
  })
  const url = await listen(server)
  const response = await fetch(`${url}/orchestrator/native/api/session/list`, {
    method: 'POST',
    headers: {
      'x-orchestrator-request': '1',
      'x-dsh-superagent-native': '1',
    },
  })
  expect(response.status).toBe(403)
  expect(authenticate).not.toHaveBeenCalled()
  expect(authenticatedFetch).not.toHaveBeenCalled()

  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/orchestrator/native/remote.mux`, {
    headers: { 'x-orchestrator-request': '1', 'x-dsh-superagent-native': '1' },
  })
  cleanup.push(() => socket.terminate())
  await expect(socketOpen(socket)).rejects.toThrow(/closed|hang up|401|403|unexpected/i)
})

it('rejects the repository capability on a request with a foreign Origin', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-origin-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const token = nativeToken(state)!
  let health: Handler | undefined
  const ctx = {
    webServer: {
      host: '127.0.0.1',
      port: 0,
      register: (route: { handler: Handler }) => {
        health = route.handler
        return () => { health = undefined }
      },
      registerUpgrade: () => () => {},
    },
    connection: {
      createSharedFetchHandler: () => ({
        requestBodyMode: () => 'buffered',
        fetch: vi.fn(),
      }),
    },
    logger: { warn: vi.fn() },
  }
  const dispose = registerNativeTransport(ctx as never, state, 'repository')
  cleanup.push(dispose)
  const server = createServer((request, response) => {
    if (health === undefined) throw new Error('repository native HTTP route is not installed')
    void health(request, response)
  })
  const url = await listen(server)
  ctx.webServer.port = Number(new URL(url).port)

  const response = await fetch(`${url}/orchestrator/native/api/session/list`, {
    headers: {
      origin: 'http://127.0.0.1:9999',
      'x-orchestrator-request': '1',
      'x-dsh-superagent-native': token,
    },
  })
  expect(response.status).toBe(403)
})

it('sends an event result as the operator that opened its event stream', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-event-peer-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const token = nativeToken(state)!
  let nativeHttp: Handler | undefined
  let nativeUpgrade: UpgradeHandler | undefined
  let operatorSequence = 0
  const operators = new Map<string, 'none' | 'answer'>()
  const streamOperator = new Map<string, string>()
  const results: { method: string; cookie: string | undefined }[] = []
  const ctx = {
    webServer: {
      host: '127.0.0.1',
      port: 0,
      register: (route: { handler: Handler }) => {
        nativeHttp = route.handler
        return () => { nativeHttp = undefined }
      },
      registerUpgrade: (route: { handler: UpgradeHandler }) => {
        nativeUpgrade = route.handler
        return () => { nativeUpgrade = undefined }
      },
    },
    connection: { authenticatedUrl: (base: string) => `${base}/?token=test`, admit: vi.fn() },
    logger: { warn: vi.fn() },
  }
  cleanup.push(registerNativeTransport(ctx as never, state, 'repository'))
  const mux = new WebSocketServer({ noServer: true })
  cleanup.push(() => new Promise<void>(resolve => mux.close(() => resolve())))
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.startsWith('/orchestrator/native/api')) {
      void nativeHttp!(request, response)
      return
    }
    if (url.pathname === '/connect') {
      const interactions = url.searchParams.get('interactions') === 'answer' ? 'answer' : 'none'
      const cookie = `dsh-auth-test=${interactions}-${++operatorSequence}`
      operators.set(cookie, interactions)
      response.writeHead(302, { location: './api/remote.mux', 'set-cookie': `${cookie}; HttpOnly; Path=/` }).end()
      return
    }
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const envelope = JSON.parse(Buffer.concat(chunks).toString()) as RpcEnvelope
      results.push({ method: envelope.method, cookie: request.headers.cookie })
      // The DSH gateway accepts an event result only from the Peer that opened the event stream.
      const clientId = ((envelope.payload as { args: { clientId: string } }).args).clientId
      const accepted = streamOperator.get(clientId) === request.headers.cookie
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: accepted
          ? { ok: true, value: null }
          : { ok: false, error: { code: 'gateway/interactions-forbidden', message: 'another Peer', details: {} } },
      }))
    })()
  })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/orchestrator/native/remote.mux') {
      nativeUpgrade!(request, socket, head)
      return
    }
    const cookie = request.headers.cookie!
    mux.handleUpgrade(request, socket, head, client => {
      cleanup.push(() => client.terminate())
      client.on('message', data => {
        const frame = JSON.parse(data.toString()) as StreamRequest
        if (frame.type !== 'open' || frame.endpoint !== '$events') return
        streamOperator.set('event-client-1', cookie)
        client.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'ready', clientId: 'event-client-1', host: { home: '' } } }))
      })
    })
  })
  const url = await listen(server)
  ctx.webServer.port = Number(new URL(url).port)
  const headers = { 'x-orchestrator-request': '1', 'x-dsh-superagent-native': token }

  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/orchestrator/native/remote.mux`, { headers })
  cleanup.push(() => socket.terminate())
  await socketOpen(socket)
  const next = frameReader(socket)
  socket.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }))
  expect(await next()).toMatchObject({ value: { type: 'ready', clientId: 'event-client-1' } })

  const response = await fetch(`${url}/orchestrator/native/api`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'answer',
      method: '$events/result',
      payload: { args: { clientId: 'event-client-1', eventId: 'question-1', outcome: { kind: 'next' } } },
    }),
  })
  expect(await response.json()).toMatchObject({ result: { ok: true } })
  expect(results).toEqual([{ method: '$events/result', cookie: streamOperator.get('event-client-1') }])
  expect(operators.get(results[0]!.cookie!)).toBe('answer')
})

it('creates one private controller capability per deployment', () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-token-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const token = nativeToken(state)!
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(nativeToken(state)).toBe(token)
  expect(statSync(join(state, 'native-proxy-token')).mode & 0o777).toBe(0o600)
})

it('reports an offline deployment only for requests that name its Sessions', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-unavailable-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1, controlScript: '/usr/bin/true', logDir: state,
    deployments: [{
      id: 'sglang',
      profile: 'superagent-sglang',
      repository: 'onenexus-team/sglang',
      url: 'http://127.0.0.1:9',
      stateDir: join(state, 'superagent-sglang'),
      workspace: '/Users/alice/src/sglang-superagent',
    }],
  }))
  const controller = await controllerHarness(state, {
    onHttp: envelope => ({ ok: true, value: envelope.method === 'session/list' ? { items: [] } : undefined }),
  })
  expect(await nativeCall(controller, 'session/list', { args: {} })).toMatchObject({ result: { ok: true, value: { items: [] } } })
  expect(await nativeCall(controller, 'session/rename', {
    args: [{ sessionId: nativeSessionId('sglang', 'session'), title: 'x' }],
  })).toMatchObject({
    result: { ok: false, error: { message: expect.stringMatching(/^onenexus-team\/sglang is unavailable:/) } },
  })
})

it('rejects a non-loopback native routing profile', () => {
  expect(() => registerNativeTransport({
    webServer: { host: '0.0.0.0' },
  } as never, '/tmp/state', 'control')).toThrow('requires a loopback Web server')
})
