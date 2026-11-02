import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { registerNativeTransport } from '../src/app/native-transport.ts'
import { nativeToken } from '../src/app/native-auth.ts'

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
type UpgradeHandler = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function socketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

it('keeps durable HTTP authentication separate from a live Remote stream through the selected deployment', async () => {
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
      client.on('message', data => { client.send(`echo:${data.toString()}`) })
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
      registerUpgrade: (route: { handler: UpgradeHandler }) => {
        controllerUpgrade = route.handler
        return () => { controllerUpgrade = undefined }
      },
    },
    connection: { requestRejection: () => undefined },
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
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(await response.json()).toEqual({ path: '/api/session/list', body: '{"payload":"fixture"}' })
  expect(admit).not.toHaveBeenCalled()
  expect(received).toEqual([{ path: '/api/session/list', body: '{"payload":"fixture"}', internal: undefined }])

  const socket = new WebSocket(`${controllerUrl.replace('http:', 'ws:')}/orchestrator/native/remote.mux`)
  cleanup.push(() => socket.terminate())
  await socketOpen(socket)
  const echoed = new Promise<string>((resolve, reject) => {
    socket.once('message', data => resolve(data.toString()))
    socket.once('error', reject)
  })
  socket.send('turn-30')
  expect(await echoed).toBe('echo:turn-30')
  const controllerClosed = new Promise<void>(resolve => socket.once('close', () => resolve()))
  socket.close()
  await controllerClosed
  await localClose

  const settings = await fetch(`${controllerUrl}/api/settings/describe`, { signal: AbortSignal.timeout(3_000) })
  expect(settings.status).toBe(200)
  expect(await settings.json()).toEqual({ path: '/api/settings/describe', body: '' })
  expect(operatorSequence).toBe(2)
  expect(issuedOperators).toEqual(['none', 'answer'])
  expect([...operatorPeers.values()]).toEqual(['none'])
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

it('creates one private controller capability per deployment', () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-native-token-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const token = nativeToken(state)!
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(nativeToken(state)).toBe(token)
  expect(statSync(join(state, 'native-proxy-token')).mode & 0o777).toBe(0o600)
})

it('returns a redacted 502 when the selected deployment is unavailable', async () => {
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
  writeFileSync(join(state, 'native-deployment.json'), JSON.stringify({ version: 1, deployment: 'sglang' }))
  let connectionRequest: ((request: IncomingMessage, response: ServerResponse, next: () => Promise<void>) => Promise<void>) | undefined
  const ctx = {
    webServer: {
      host: '127.0.0.1',
      port: 0,
      registerUpgrade: () => () => {},
    },
    connection: { requestRejection: () => undefined },
    logger: { warn: vi.fn() },
    on: (_event: string, handler: NonNullable<typeof connectionRequest>) => {
      connectionRequest = handler
      return () => { connectionRequest = undefined }
    },
  }
  const dispose = registerNativeTransport(ctx as never, state, 'control')
  cleanup.push(dispose)
  const server = createServer((request, response) => {
    if (connectionRequest === undefined) throw new Error('controller native HTTP interceptor is not installed')
    void connectionRequest(request, response, async () => {
      response.writeHead(500).end('controller-local API reached')
    })
  })
  const url = await listen(server)
  ctx.webServer.port = Number(new URL(url).port)
  const response = await fetch(`${url}/api/session/list`, { method: 'POST' })
  expect(response.status).toBe(502)
  expect(await response.text()).toMatch(/^Deployment unavailable:/)
})

it('rejects a non-loopback native routing profile', () => {
  expect(() => registerNativeTransport({
    webServer: { host: '0.0.0.0' },
  } as never, '/tmp/state', 'control')).toThrow('requires a loopback Web server')
})
