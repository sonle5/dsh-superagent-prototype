/** Public, session-authenticated gateway for a server-local Superagent fleet. */
import type { Context } from '@deepseek-ai/cordis'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { isAbsolute, join } from 'node:path'
import { Readable } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { z } from 'zod'
import { DEPLOYMENT_ROUTES, matchesRoute } from './api.ts'
import { nativeToken } from './native-auth.ts'
import { INTERNAL_HEADER, INTERNAL_REQUEST_HEADER } from './native-transport.ts'
import { LIMITS } from '../limits.ts'

const PREFIX = '/gateway/api'
const COOKIE = 'dsh-superagent-gateway'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const GITHUB_DEVICE_URL = 'https://github.com/login/device/code'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_USER_URL = 'https://api.github.com/user'
const NATIVE_MAX_BODY_BYTES = 300 * 1024 * 1024

const organization = z.string().trim().regex(/^[A-Za-z0-9_.-]+$/, 'GitHub organization login')
const Deployment = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase deployment id'),
  profile: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, 'DSH profile name'),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/repository'),
  url: z.string().url().refine(value => {
    const target = new URL(value)
    return target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
      && target.pathname === '/' && !target.search && !target.hash
  }, 'Loopback HTTP URL'),
  stateDir: z.string().refine(isAbsolute, 'Absolute path'),
  workspace: z.string().refine(isAbsolute, 'Absolute path'),
})
const Registry = z.object({
  version: z.literal(1),
  organization,
  githubClientId: z.string().regex(/^[A-Za-z0-9]{20,}$/, 'GitHub OAuth client id'),
  deployments: z.array(Deployment),
}).superRefine((value, context) => {
  for (const field of ['id', 'profile', 'url', 'stateDir'] as const) {
    const seen = new Set<string>()
    for (const deployment of value.deployments) {
      if (seen.has(deployment[field])) context.addIssue({ code: 'custom', path: ['deployments', field],
        message: `Duplicate deployment ${field}: ${deployment[field]}` })
      seen.add(deployment[field])
    }
  }
})
type RegistryConfig = z.infer<typeof Registry>

const DeviceCode = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().default(5),
})
const DeviceToken = z.union([
  z.object({ access_token: z.string().min(1) }),
  z.object({ error: z.string() }),
])
const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/) })

/** A client-facing refusal with the HTTP status the gateway should return. */
class GatewayError extends Error { constructor(readonly status: number, message: string) { super(message) } }

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...headers })
  res.end(JSON.stringify(value))
}

async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes) throw new GatewayError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try { return JSON.parse((await readBody(req)).toString('utf8')) as Record<string, unknown> }
  catch (error) {
    if (error instanceof GatewayError) throw error
    throw new GatewayError(400, 'The request body is not JSON')
  }
}

function loadRegistry(stateDir: string): RegistryConfig {
  const path = join(stateDir, 'gateway.json')
  if (!existsSync(path)) throw new GatewayError(503, 'The gateway is not configured')
  try { return Registry.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown) }
  catch { throw new GatewayError(503, 'The gateway registry is invalid') }
}

function sessionSecret(stateDir: string): Buffer {
  const path = join(stateDir, 'gateway-session-secret')
  try { return Buffer.from(readFileSync(path, 'utf8').trim(), 'base64url') }
  catch {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const value = randomBytes(32)
    try {
      writeFileSync(path, `${value.toString('base64url')}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return Buffer.from(readFileSync(path, 'utf8').trim(), 'base64url')
    }
  }
}

function sessionValue(stateDir: string, login: string, expiresAt: number): string {
  const message = `${login}.${expiresAt}`
  return `${message}.${createHmac('sha256', sessionSecret(stateDir)).update(message).digest('base64url')}`
}

function sessionLogin(stateDir: string, request: IncomingMessage): string | undefined {
  const header = request.headers[INTERNAL_HEADER]
  const value = typeof header === 'string' ? header
    : new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(request.headers.cookie ?? '')?.[1]
  if (value === undefined) return undefined
  const parts = value.split('.')
  if (parts.length !== 3) return undefined
  const [login, expires, signature] = parts as [string, string, string]
  if (!/^[A-Za-z0-9-]+$/.test(login) || !/^\d+$/.test(expires) || Number(expires) <= Date.now()) return undefined
  const expected = createHmac('sha256', sessionSecret(stateDir)).update(`${login}.${expires}`).digest()
  const actual = Buffer.from(signature, 'base64url')
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected) ? login : undefined
}

function setSession(res: ServerResponse, stateDir: string, login: string, secure: boolean): { expiresAt: number; nativeToken: string } {
  const expiresAt = Date.now() + SESSION_TTL_MS
  const nativeToken = sessionValue(stateDir, login, expiresAt)
  res.setHeader('set-cookie', `${COOKIE}=${nativeToken}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`)
  return { expiresAt, nativeToken }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

async function githubJson<T extends z.ZodType>(fetcher: FetchLike, url: string, schema: T, init: RequestInit): Promise<z.infer<T>> {
  const response = await fetcher(url, init)
  const text = await response.text()
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new GatewayError(502, 'GitHub returned an invalid response') }
  if (!response.ok) throw new GatewayError(502, `GitHub request failed with ${response.status}`)
  try { return schema.parse(value) } catch { throw new GatewayError(502, 'GitHub returned an unexpected response') }
}

async function issueSession(
  fetcher: FetchLike,
  req: IncomingMessage,
  res: ServerResponse,
  registry: RegistryConfig,
  stateDir: string,
  secure: boolean,
): Promise<void> {
  const deviceCode = z.string().min(1).parse((await jsonBody(req)).device_code)
  const token = DeviceToken.parse(await githubJson(fetcher, GITHUB_TOKEN_URL, DeviceToken, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: registry.githubClientId, device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
  }))
  if ('error' in token) {
    json(res, token.error === 'slow_down' ? 429 : 202, { status: token.error })
    return
  }
  const authorization = `Bearer ${token.access_token}`
  const user = await githubJson(fetcher, GITHUB_USER_URL, GithubUser, { headers: { accept: 'application/vnd.github+json', authorization } })
  const member = await fetcher(`https://api.github.com/orgs/${encodeURIComponent(registry.organization)}/members/${encodeURIComponent(user.login)}`,
    { headers: { accept: 'application/vnd.github+json', authorization } })
  await member.body?.cancel()
  if (member.status !== 204) {
    json(res, 403, { error: `GitHub account is not a member of ${registry.organization}` })
    return
  }
  const session = setSession(res, stateDir, user.login, secure)
  json(res, 200, { login: user.login, organization: registry.organization,
    expiresAt: String(session.expiresAt), nativeToken: session.nativeToken })
}

async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  deployment: RegistryConfig['deployments'][number],
  suffix: string,
): Promise<void> {
  const method = req.method ?? 'GET'
  if (!matchesRoute(DEPLOYMENT_ROUTES, method, suffix.split('/'))) {
    json(res, 404, { error: 'Unknown operation' })
    return
  }
  const token = nativeToken(deployment.stateDir, false)
  if (token === undefined) {
    json(res, 503, { error: `Deployment native capability is missing for ${deployment.id}` })
    return
  }
  const source = new URL(req.url ?? '/', 'http://dsh.internal')
  const target = new URL(`/orchestrator/api/${suffix}`, deployment.url)
  target.search = source.search
  const bodyless = method === 'GET' || method === 'HEAD'
  const payload = bodyless ? undefined : await readBody(req, 4 * LIMITS.promptMaxChars.max + 4096)
  try {
    const response = await fetch(target, {
      method,
      headers: { accept: 'application/json', 'x-orchestrator-request': '1', [INTERNAL_HEADER]: token,
        ...payload?.length ? { 'content-type': req.headers['content-type'] ?? 'application/json' } : {} },
      ...payload ? { body: new Uint8Array(payload) } : {},
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    res.writeHead(response.status, {
      'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(await response.text())
  } catch (error) {
    if (res.headersSent) {
      res.end()
      return
    }
    json(res, 502, { error: `Deployment unavailable: ${error instanceof Error ? error.message : String(error)}` })
  }
}

function nativeHeaders(deployment: RegistryConfig['deployments'][number]): Record<string, string> {
  const token = nativeToken(deployment.stateDir, false)
  if (token === undefined) throw new GatewayError(503, `Deployment native capability is missing for ${deployment.id}`)
  return {
    host: new URL(deployment.url).host,
    origin: deployment.url,
    [INTERNAL_REQUEST_HEADER]: '1',
    [INTERNAL_HEADER]: token,
  }
}

async function forwardNativeHttp(
  req: IncomingMessage,
  res: ServerResponse,
  deployment: RegistryConfig['deployments'][number],
): Promise<void> {
  const source = new URL(req.url ?? '/', 'http://dsh.internal')
  const target = new URL('/orchestrator/native/api', deployment.url)
  target.search = source.search
  try {
    const body = req.method === undefined || req.method === 'GET' || req.method === 'HEAD' ? undefined
      : Readable.toWeb(req) as ReadableStream<Uint8Array>
    const response = await fetch(target, {
      method: req.method ?? 'GET',
      headers: { ...nativeHeaders(deployment), ...req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {} },
      ...body ? { body, duplex: 'half' } : {},
      redirect: 'error',
      signal: abortOnDisconnect(res).signal,
    } as RequestInit & { duplex: 'half' })
    res.writeHead(response.status, {
      'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(await response.text())
  } catch (error) {
    if (res.headersSent) {
      res.end()
      return
    }
    json(res, 502, { error: `Deployment native transport unavailable: ${error instanceof Error ? error.message : String(error)}` })
  }
}

function abortOnDisconnect(res: ServerResponse): AbortController {
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  return abort
}

function proxyNativeMux(
  ctx: Context,
  stateDir: string,
  deployment: RegistryConfig['deployments'][number],
): { handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>; close: () => void } {
  const server = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  const handler = async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    if (sessionLogin(stateDir, request) === undefined) {
      socket.destroy()
      return
    }
    const target = new URL('/orchestrator/native/remote.mux', deployment.url)
    server.handleUpgrade(request, socket, head, client => {
      let opened = false
      const early: { data: RawData; binary: boolean }[] = []
      const hold = (data: RawData, binary: boolean): void => { early.push({ data, binary }) }
      client.on('message', hold)
      let upstream: WebSocket
      try {
        upstream = new WebSocket(target.toString().replace(/^http:/, 'ws:'), { headers: nativeHeaders(deployment) })
      } catch (error) {
        client.close(1011, 'Deployment native transport unavailable')
        ctx.logger.warn('Gateway native websocket failed for %s: %s', deployment.id,
          error instanceof Error ? error.message : String(error))
        return
      }
      const closeBoth = (): void => {
        client.terminate()
        upstream.terminate()
      }
      upstream.on('open', () => {
        opened = true
        client.off('message', hold)
        for (const item of early.splice(0)) upstream.send(item.data, { binary: item.binary })
      })
      upstream.on('message', data => {
        if (client.readyState === WebSocket.OPEN) client.send(data)
      })
      upstream.on('close', () => client.close())
      upstream.on('error', () => {
        if (!opened) client.close(1011, 'Deployment native transport unavailable')
        else closeBoth()
      })
      client.on('close', () => upstream.close())
      client.on('error', closeBoth)
    })
  }
  return { handler, close: () => server.close() }
}

/** Register the gateway API on DSH's configured public Web server. */
export function registerGateway(ctx: Context, stateDir: string, fetcher: FetchLike = fetch): () => void {
  const deploymentPath = /^\/gateway\/api\/deployment\/([a-z0-9][a-z0-9-]*)\/(.+)$/
  const nativePath = /^\/gateway\/native\/([a-z0-9][a-z0-9-]*)\/api(?:\/.*)?$/
  const disposeHttp = ctx.webServer.register({ kind: 'prefix', path: '/gateway', handler: async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    try {
      const registry = loadRegistry(stateDir)
      const origin = req.headers.origin
      if (origin !== undefined && origin !== `${ctx.webServer.protocol}//${req.headers.host}`) {
        throw new GatewayError(403, 'Same-origin gateway request required')
      }
      if (url.pathname === `${PREFIX}/device` && req.method === 'POST') {
        const value = DeviceCode.parse(await githubJson(fetcher, GITHUB_DEVICE_URL, DeviceCode, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: registry.githubClientId, scope: 'read:org' }),
        }))
        json(res, 200, value)
        return
      }
      if (url.pathname === `${PREFIX}/session` && req.method === 'POST') {
        await issueSession(fetcher, req, res, registry, stateDir, ctx.webServer.protocol === 'https:')
        return
      }
      const login = sessionLogin(stateDir, req)
      if (login === undefined) throw new GatewayError(401, 'Gateway sign-in required')
      if (url.pathname === `${PREFIX}/fleet` && req.method === 'GET') {
        json(res, 200, { organization: registry.organization, login,
          deployments: registry.deployments.map(({ id, profile, repository }) => ({ id, profile, repository })) })
        return
      }
      const native = nativePath.exec(url.pathname)
      if (native) {
        const target = registry.deployments.find(item => item.id === native[1])
        if (!target) throw new GatewayError(404, `Deployment not found: ${native[1]}`)
        await forwardNativeHttp(req, res, target)
        return
      }
      const deployment = deploymentPath.exec(url.pathname)
      if (deployment) {
        const target = registry.deployments.find(item => item.id === deployment[1])
        if (!target) throw new GatewayError(404, `Deployment not found: ${deployment[1]}`)
        await forward(req, res, target, deployment[2]!)
        return
      }
      throw new GatewayError(404, 'Unknown operation')
    } catch (error) {
      if (res.headersSent) return
      const status = error instanceof z.ZodError ? 400 : error instanceof GatewayError ? error.status : 500
      json(res, status, { error: status === 500 ? 'Gateway request failed' : error instanceof Error ? error.message : String(error) })
    }
  } })
  let registry: RegistryConfig | undefined
  try { registry = loadRegistry(stateDir) } catch { /* The HTTP route reports the invalid registry. */ }
  const nativeRoutes = (registry?.deployments ?? []).map(deployment => {
    const route = proxyNativeMux(ctx, stateDir, deployment)
    return {
      dispose: ctx.webServer.registerUpgrade({ path: `/gateway/native/${deployment.id}/remote.mux`, handler: route.handler }),
      close: route.close,
    }
  })
  return () => {
    for (const route of nativeRoutes.reverse()) {
      route.dispose()
      route.close()
    }
    disposeHttp()
  }
}
