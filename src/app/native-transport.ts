/** Deployment-aware native DSH HTTP and Remote-stream transport for the Desktop control plane. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { isLoopbackHost } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable, type Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { Fleet, FleetControlError, redactSensitive } from './fleet.ts'
import { matchesNativeToken } from './native-auth.ts'

const NATIVE_API = '/orchestrator/native/api'
const NATIVE_MUX = '/orchestrator/native/remote.mux'
const INTERNAL_REQUEST_HEADER = 'x-orchestrator-request'
const INTERNAL_HEADER = 'x-dsh-superagent-native'
const HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'origin',
  'proxy-authenticate',
  'proxy-authorization',
  'sec-fetch-site',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  INTERNAL_REQUEST_HEADER,
  INTERNAL_HEADER,
])

type NativeRole = 'control' | 'repository'

function requestTarget(request: IncomingMessage): { host: string; origin?: string } | undefined {
  const host = request.headers.host
  if (host === undefined) return undefined
  const origin = request.headers.origin
  return { host, ...typeof origin === 'string' ? { origin } : {} }
}

function internalRequest(request: IncomingMessage, port: number, stateDir: string): boolean {
  const target = requestTarget(request)
  if (target === undefined || target.host !== `127.0.0.1:${port}` && target.host !== `localhost:${port}`) return false
  if (request.headers[INTERNAL_REQUEST_HEADER] !== '1' || !matchesNativeToken(stateDir, request.headers[INTERNAL_HEADER])) return false
  return target.origin === undefined || target.origin === `http://${target.host}`
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of response.headers) {
    if (!HOP_HEADERS.has(name.toLowerCase())) headers[name] = value
  }
  return headers
}

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, responseHeaders(response))
  if (response.body === null) {
    res.end()
    return
  }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise<void>(resolve => {
        const done = (): void => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.once('drain', done)
        res.once('close', done)
      })
    }
  }
  res.end()
}

function abortOnDisconnect(res: ServerResponse): AbortController {
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  return abort
}

async function proxyHttp(req: IncomingMessage, res: ServerResponse, target: URL, extra: Record<string, string>): Promise<void> {
  const abort = abortOnDisconnect(res)
  const method = req.method ?? 'GET'
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_HEADERS.has(name.toLowerCase()) || value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  const bodyless = method === 'GET' || method === 'HEAD'
  const response = await fetch(target, {
    method,
    headers,
    ...bodyless ? {} : { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' },
    redirect: 'error',
    signal: abort.signal,
  } as RequestInit & { duplex: 'half' })
  await writeResponse(response, res)
}

function relaySockets(client: WebSocket, upstream: WebSocket, initial: { data: RawData; binary: boolean }[] = []): void {
  const pending = [...initial]
  let clientClosed = false
  let upstreamClosed = false
  const closeBoth = (code: number, reason: Buffer): void => {
    const relayCode = (code >= 1000 && code <= 1014 && code !== 1005 && code !== 1006) || code >= 3000 && code <= 4999
      ? code : 1000
    if (!clientClosed) {
      clientClosed = true
      client.close(relayCode, reason)
    }
    if (!upstreamClosed) {
      upstreamClosed = true
      upstream.close(relayCode, reason)
    }
  }
  client.on('message', (data, binary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
    else if (upstream.readyState === WebSocket.CONNECTING) pending.push({ data, binary })
  })
  client.on('close', (code, reason) => closeBoth(code, reason))
  client.on('error', () => upstream.terminate())
  upstream.on('open', () => {
    for (const item of pending.splice(0)) upstream.send(item.data, { binary: item.binary })
  })
  upstream.on('message', (data, binary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary })
  })
  upstream.on('close', (code, reason) => closeBoth(code, reason))
  upstream.on('error', () => client.terminate())
}

function webSocketUrl(base: string, path: string): string {
  const url = new URL(path, base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

function acceptUpgrade(server: WebSocketServer, request: IncomingMessage, socket: Duplex, head: Buffer,
  open: (client: WebSocket) => void): void {
  server.handleUpgrade(request, socket, head, (client) => {
    server.emit('connection', client, request)
    open(client)
  })
}

function controllerUpgrade(ctx: Context, stateDir: string, server: WebSocketServer) {
  const fleet = new Fleet(stateDir)
  return (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (ctx.connection.requestRejection(request) !== undefined) {
      socket.destroy()
      return
    }
    let target: ReturnType<Fleet['nativeTarget']>
    try {
      target = fleet.nativeTarget()
    } catch (error) {
      ctx.logger.warn('native Session proxy selection failed: %s', redactSensitive(error instanceof Error ? error.message : String(error)))
      socket.destroy()
      return
    }
    acceptUpgrade(server, request, socket, head, (client) => {
      const host = request.headers.host
      const origin = request.headers.origin
      const cookie = request.headers.cookie
      if (target === undefined && host !== undefined) {
        const upstream = new WebSocket(webSocketUrl(`http://${host}`, '/api/remote.mux'), {
          headers: {
            ...cookie === undefined ? {} : { cookie },
            ...origin === undefined ? {} : { origin },
            'sec-fetch-site': 'same-origin',
          },
        })
        relaySockets(client, upstream)
        return
      }
      if (target === undefined) {
        client.close(1011, 'Deployment selection unavailable')
        return
      }
      const upstream = new WebSocket(webSocketUrl(target.url, NATIVE_MUX), {
        headers: { 'x-orchestrator-request': '1', [INTERNAL_HEADER]: target.token },
      })
      relaySockets(client, upstream)
    })
  }
}

function repositoryAuth(ctx: Context) {
  const mint = async (interactions: 'none' | 'answer'): Promise<string> => {
    const base = `http://127.0.0.1:${ctx.webServer.port}`
    const login = new URL(ctx.connection.authenticatedUrl(base))
    const operatorPeers = typeof (ctx.connection as { admit?: unknown }).admit === 'function'
    if (operatorPeers) {
      login.pathname = '/connect'
      login.searchParams.set('interactions', interactions)
    }
    const response = await fetch(login, { redirect: 'manual' })
    const value = response.headers.get('set-cookie')?.split(';', 1)[0]
    await response.body?.cancel()
    if (![302, 303].includes(response.status) || value === undefined || value === '') {
      throw new Error(`native Session proxy authentication returned ${response.status}`)
    }
    return value
  }
  let httpCookie: Promise<string> | undefined
  return {
    http: (): Promise<string> => {
      httpCookie ??= mint('none').catch(error => {
        httpCookie = undefined
        throw error
      })
      return httpCookie
    },
    mux: (): Promise<string> => mint('answer'),
  }
}

function repositoryUpgrade(ctx: Context, stateDir: string, server: WebSocketServer, auth: ReturnType<typeof repositoryAuth>) {
  return (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!internalRequest(request, ctx.webServer.port, stateDir)) {
      socket.destroy()
      return
    }
    acceptUpgrade(server, request, socket, head, (client) => {
      const early: { data: RawData; binary: boolean }[] = []
      const hold = (data: RawData, binary: boolean): void => { early.push({ data, binary }) }
      client.on('message', hold)
      void auth.mux().then(value => {
        const base = `http://127.0.0.1:${ctx.webServer.port}`
        const upstream = new WebSocket(webSocketUrl(base, '/api/remote.mux'), {
          headers: { cookie: value, origin: base, 'sec-fetch-site': 'same-origin' },
        })
        client.off('message', hold)
        relaySockets(client, upstream, early)
      }, (error: unknown) => {
        client.off('message', hold)
        ctx.logger.warn('native Session proxy authentication failed: %s', redactSensitive(error instanceof Error ? error.message : String(error)))
        client.close(1011, 'Deployment authentication failed')
      })
    })
  }
}

function repositoryHttp(ctx: Context, stateDir: string, auth: ReturnType<typeof repositoryAuth>) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!internalRequest(request, ctx.webServer.port, stateDir)) {
      response.writeHead(403)
      response.end()
      return
    }
    const source = new URL(request.url ?? '/', 'http://dsh.internal')
    const suffix = source.pathname.slice(NATIVE_API.length)
    const base = `http://127.0.0.1:${ctx.webServer.port}`
    const target = new URL(`/api${suffix}`, base)
    target.search = source.search
    try {
      await proxyHttp(request, response, target, {
        host: `127.0.0.1:${ctx.webServer.port}`,
        origin: base,
        cookie: await auth.http(),
        'sec-fetch-site': 'same-origin',
      })
    } catch (error) {
      const message = redactSensitive(error instanceof Error ? error.message : String(error))
      ctx.logger.warn('native Session proxy request failed for %s: %s', target.pathname, message)
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      if (!response.writableEnded) response.end(`Deployment authentication failed: ${message}`)
    }
  }
}

function controlHttp(ctx: Context, stateDir: string) {
  const fleet = new Fleet(stateDir)
  return async (request: IncomingMessage, response: ServerResponse, next: () => Promise<void>): Promise<void> => {
    if (request.url !== '/api' && !request.url?.startsWith('/api/') && !request.url?.startsWith('/api?')) {
      await next()
      return
    }
    let target: ReturnType<Fleet['nativeTarget']>
    try {
      target = fleet.nativeTarget()
    } catch (error) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(redactSensitive(error instanceof Error ? error.message : String(error)))
      return
    }
    if (target === undefined) {
      await next()
      return
    }
    const source = new URL(request.url ?? '/', 'http://dsh.internal')
    const proxied = new URL(`/orchestrator/native${source.pathname}`, target.url)
    proxied.search = source.search
    try {
      await proxyHttp(request, response, proxied, { [INTERNAL_REQUEST_HEADER]: '1', [INTERNAL_HEADER]: target.token })
    } catch (error) {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      if (!response.writableEnded) response.end(redactSensitive(`Deployment unavailable: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
}

/**
 * Register the controller or repository half of native DSH Session routing.
 * @param ctx - Host context with Connection and Web server services.
 * @param stateDir - Controller registry directory.
 * @param role - Control process or repository-bound deployment process.
 * @returns Disposer restoring every route and interceptor.
 */
export function registerNativeTransport(ctx: Context, stateDir: string, role: NativeRole): () => void {
  if (!isLoopbackHost(ctx.webServer.host)) throw new Error('Native Session routing requires a loopback Web server')
  const server = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  const disposers: (() => void)[] = []
  if (role === 'control') {
    disposers.push(ctx.on('connection/request', controlHttp(ctx, stateDir)))
    disposers.push(ctx.webServer.registerUpgrade({
      path: NATIVE_MUX,
      handler: controllerUpgrade(ctx, stateDir, server),
    }))
  } else {
    const auth = repositoryAuth(ctx)
    disposers.push(ctx.webServer.register({ kind: 'prefix', path: NATIVE_API, handler: repositoryHttp(ctx, stateDir, auth) }))
    disposers.push(ctx.webServer.registerUpgrade({
      path: NATIVE_MUX,
      handler: repositoryUpgrade(ctx, stateDir, server, auth),
    }))
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
    for (const client of server.clients) client.terminate()
    server.close()
  }
}
