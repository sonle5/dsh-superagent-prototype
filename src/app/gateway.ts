/** Public, session-authenticated gateway for a server-local Superagent fleet. */
import type { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  tokenDir: z.string().refine(isAbsolute, 'Absolute path').optional(),
  ownerLogin: organization.optional(),
})
const Person = z.object({
  login: z.string().regex(/^[A-Za-z0-9-]+$/, 'GitHub login'),
  deployments: z.array(Deployment),
})
const Onboarding = z.object({
  command: z.array(z.string().min(1)).min(1),
  gatewayUser: z.string().regex(/^[a-z_][a-z0-9-]*$/, 'Linux user name'),
  gatewayGroup: z.string().regex(/^[a-z_][a-z0-9-]*$/, 'Linux group name'),
  checkout: z.string().refine(isAbsolute, 'Absolute path'),
  baseDir: z.string().refine(isAbsolute, 'Absolute path'),
})
const Registry = z.object({
  version: z.literal(1),
  organization,
  githubClientId: z.string().regex(/^[A-Za-z0-9]{20,}$/, 'GitHub OAuth client id'),
  deployments: z.array(Deployment).default([]),
  people: z.array(Person).default([]),
  onboarding: Onboarding.optional(),
}).superRefine((value, context) => {
  const all = [...value.deployments, ...value.people.flatMap(person => person.deployments)]
  for (const field of ['id', 'profile', 'url', 'stateDir'] as const) {
    const seen = new Set<string>()
    for (const deployment of all) {
      if (seen.has(deployment[field])) context.addIssue({ code: 'custom', path: ['deployments', field],
        message: `Duplicate deployment ${field}: ${deployment[field]}` })
      seen.add(deployment[field])
    }
  }
  const repositories = new Set(all.map(deployment => deployment.repository))
  if (repositories.size !== all.length) {
    context.addIssue({ code: 'custom', path: ['deployments'],
      message: 'Each repository may have only one deployment' })
  }
  const logins = new Set(value.people.map(person => person.login))
  if (logins.size !== value.people.length) {
    context.addIssue({ code: 'custom', path: ['people'], message: 'Duplicate person login' })
  }
})
type RegistryConfig = z.infer<typeof Registry>
type DeploymentConfig = z.infer<typeof Deployment>

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
const OnboardingDeployment = Deployment.extend({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase deployment id'),
  tokenDir: z.string().refine(isAbsolute, 'Absolute path'),
})
const OnboardingCredentials = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase deployment id'),
  cli: z.string().refine(isAbsolute, 'Absolute path'),
})
const SettingsSources = z.object({
  sources: z.array(z.object({
    id: z.string().min(1),
    revision: z.number().int().nonnegative(),
    value: z.object({
      enabled: z.boolean().default(true),
      config: z.record(z.string(), z.unknown()),
    }),
  })),
})
const SettingsSave = z.object({
  saved: z.boolean(),
  revision: z.number().int().nonnegative(),
  restarting: z.boolean(),
})

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

function saveRegistry(stateDir: string, registry: RegistryConfig): void {
  const path = join(stateDir, 'gateway.json')
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(registry)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

function personDeployments(registry: RegistryConfig, login: string): DeploymentConfig[] {
  const person = registry.people.find(item => item.login === login)
  const owned = registry.deployments.filter(deployment => deployment.ownerLogin === login)
  return person === undefined ? owned : [...person.deployments, ...owned]
}

function findDeployment(registry: RegistryConfig, login: string, id: string): DeploymentConfig | undefined {
  return personDeployments(registry, login).find(deployment => deployment.id === id)
}

function allDeployments(registry: RegistryConfig): DeploymentConfig[] {
  return [...registry.deployments, ...registry.people.flatMap(person => person.deployments)]
}

function deploymentToken(deployment: DeploymentConfig): string | undefined {
  return nativeToken(deployment.tokenDir ?? deployment.stateDir, false)
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
const ONBOARDING_TIMEOUT_MS = 180_000

async function runOnboarding(config: RegistryConfig['onboarding'], request: unknown): Promise<unknown> {
  if (!config) throw new GatewayError(501, 'Self-service onboarding is not configured')
  const [command, ...args] = config.command
  return await new Promise((resolve, reject) => {
    const child = spawn(command!, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: unknown, value?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(new GatewayError(504, 'Self-service onboarding timed out'))
    }, ONBOARDING_TIMEOUT_MS)
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.once('error', error => finish(new GatewayError(502, `Self-service onboarding failed: ${error.message}`)))
    child.once('close', code => {
      if (code !== 0) {
        const output = [stdout, stderr].filter(Boolean).join('').trim()
        finish(new GatewayError(502, `Self-service onboarding failed: ${output || `exit ${code}`}`))
      }
      else {
        try { finish(undefined, JSON.parse(stdout)) }
        catch { finish(new GatewayError(502, 'Self-service onboarding returned invalid JSON')) }
      }
    })
    child.stdin.end(`${JSON.stringify(request)}\n`)
  })
}

async function githubJson<T extends z.ZodType>(fetcher: FetchLike, url: string, schema: T, init: RequestInit): Promise<z.infer<T>> {
  const response = await fetcher(url, init)
  const text = await response.text()
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new GatewayError(502, 'GitHub returned an invalid response') }
  if (!response.ok) throw new GatewayError(502, `GitHub request failed with ${response.status}`)
  try { return schema.parse(value) } catch { throw new GatewayError(502, 'GitHub returned an unexpected response') }
}

async function deploymentJson(
  deployment: DeploymentConfig,
  suffix: string,
  init: RequestInit = {},
): Promise<unknown> {
  const token = deploymentToken(deployment)
  if (token === undefined) throw new GatewayError(503, `Deployment native capability is missing for ${deployment.id}`)
  const response = await fetch(new URL(`/orchestrator/api/${suffix}`, deployment.url), {
    ...init,
    headers: {
      accept: 'application/json',
      'x-orchestrator-request': '1',
      [INTERNAL_HEADER]: token,
      ...typeof init.body === 'string' ? { 'content-type': 'application/json' } : {},
      ...init.headers,
    },
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const error = value as { error?: unknown } | undefined
    throw new GatewayError(response.status, typeof error?.error === 'string' ? error.error : `Deployment returned ${response.status}`)
  }
  return value
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
  const token = deploymentToken(deployment)
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
  const token = deploymentToken(deployment)
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
  const suffix = /^\/gateway\/native\/[a-z0-9][a-z0-9-]*\/api(\/.*)?$/.exec(source.pathname)?.[1] ?? ''
  const target = new URL(`/orchestrator/native/api${suffix}`, deployment.url)
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
  deployment: DeploymentConfig,
): { handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>; close: () => void } {
  const server = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  const handler = async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const login = sessionLogin(stateDir, request)
    if (login === undefined) {
      socket.destroy()
      return
    }
    let registry: RegistryConfig
    try { registry = loadRegistry(stateDir) }
    catch {
      socket.destroy()
      return
    }
    const current = findDeployment(registry, login, deployment.id)
    if (current === undefined) {
      socket.destroy()
      return
    }
    const target = new URL('/orchestrator/native/remote.mux', current.url)
    server.handleUpgrade(request, socket, head, client => {
      let opened = false
      const early: { data: RawData; binary: boolean }[] = []
      const hold = (data: RawData, binary: boolean): void => { early.push({ data, binary }) }
      client.on('message', hold)
      let upstream: WebSocket
      try {
        upstream = new WebSocket(target.toString().replace(/^http:/, 'ws:'), { headers: nativeHeaders(current) })
      } catch (error) {
        client.close(1011, 'Deployment native transport unavailable')
        ctx.logger.warn('Gateway native websocket failed for %s: %s', current.id,
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
        client.on('message', (data, binary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
        })
        for (const item of early.splice(0)) upstream.send(item.data, { binary: item.binary })
      })
      upstream.on('message', (data, binary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary })
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
  const credentialPath = /^\/gateway\/api\/deployment\/([a-z0-9][a-z0-9-]*)\/credentials$/
  const nativePath = /^\/gateway\/native\/([a-z0-9][a-z0-9-]*)\/api(?:\/.*)?$/
  type NativeRoute = { dispose: () => void; close: () => void }
  const nativeRoutes: NativeRoute[] = []
  const registerNativeRoute = (deployment: DeploymentConfig): void => {
    const route = proxyNativeMux(ctx, stateDir, deployment)
    nativeRoutes.push({
      dispose: ctx.webServer.registerUpgrade({ path: `/gateway/native/${deployment.id}/remote.mux`, handler: route.handler }),
      close: route.close,
    })
  }
  let onboardingBusy = false
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
      if (url.pathname === `${PREFIX}/person` && req.method === 'POST') {
        if (onboardingBusy) throw new GatewayError(409, 'Another onboarding operation is already running')
        onboardingBusy = true
        try {
          if (registry.people.some(person => person.login === login)) {
            json(res, 200, { login, created: false })
            return
          }
          const created = z.object({ user: z.string().min(1), home: z.string().min(1) })
            .parse(await runOnboarding(registry.onboarding, {
              operation: 'person', login, ...registry.onboarding,
            }))
          registry.people.push({ login, deployments: [] })
          saveRegistry(stateDir, registry)
          json(res, 201, { login, user: created.user, created: true })
        } finally { onboardingBusy = false }
        return
      }
      if (url.pathname === `${PREFIX}/deployment` && req.method === 'POST') {
        if (onboardingBusy) throw new GatewayError(409, 'Another onboarding operation is already running')
        onboardingBusy = true
        try {
          const request = z.object({
            id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase deployment id'),
            repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/repository'),
          }).parse(await jsonBody(req))
          const known = allDeployments(registry)
          if (known.some(deployment => deployment.id === request.id)) {
            throw new GatewayError(409, `Deployment id already exists: ${request.id}`)
          }
          if (known.some(deployment => deployment.repository === request.repository)) {
            throw new GatewayError(409, `Repository already has a deployment: ${request.repository}`)
          }
          let person = registry.people.find(item => item.login === login)
          if (person === undefined) {
            await runOnboarding(registry.onboarding, {
              operation: 'person', login, ...registry.onboarding,
            })
            person = { login, deployments: [] }
            registry.people.push(person)
          }
          const deployment = OnboardingDeployment.parse(await runOnboarding(registry.onboarding, {
            operation: 'deployment', login, ...request, ...registry.onboarding,
            usedPorts: known.map(deployment => deployment.url),
          }))
          if (deployment.id !== request.id || deployment.repository !== request.repository) {
            throw new GatewayError(502, 'Self-service onboarding returned a different deployment')
          }
          person.deployments.push(deployment)
          saveRegistry(stateDir, registry)
          registerNativeRoute(deployment)
          json(res, 201, {
            login,
            deployment: {
              id: deployment.id, profile: deployment.profile, repository: deployment.repository,
              url: deployment.url, stateDir: deployment.stateDir, workspace: deployment.workspace,
            },
            created: true,
          })
        } finally { onboardingBusy = false }
        return
      }
      const credentials = credentialPath.exec(url.pathname)
      if (credentials && req.method === 'POST') {
        const deployment = findDeployment(registry, login, credentials[1]!)
        if (!deployment) throw new GatewayError(404, `Deployment not found: ${credentials[1]}`)
        const request = z.object({
          githubToken: z.string().regex(/^[A-Za-z0-9_-]{20,255}$/, 'GitHub token'),
        }).parse(await jsonBody(req))
        const created = OnboardingCredentials.parse(await runOnboarding(registry.onboarding, {
          operation: 'credentials', login, id: deployment.id, githubToken: request.githubToken,
          ...registry.onboarding,
        }))
        if (created.id !== deployment.id) {
          throw new GatewayError(502, 'Self-service onboarding returned a different deployment')
        }
        const settings = SettingsSources.parse(await deploymentJson(deployment, 'settings'))
        const github = settings.sources.find(source => source.id === 'github')
        if (github === undefined) throw new GatewayError(502, 'Deployment has no GitHub Source')
        const saved = SettingsSave.parse(await deploymentJson(deployment, 'settings/source:github', {
          method: 'PUT',
          body: JSON.stringify({
            revision: github.revision,
            value: {
              ...github.value,
              enabled: true,
              config: {
                ...github.value.config,
                repository: deployment.repository,
                cli: created.cli,
              },
            },
          }),
        }))
        json(res, 200, { saved: saved.saved, revision: saved.revision, restarting: saved.restarting })
        return
      }
      if (url.pathname === `${PREFIX}/fleet` && req.method === 'GET') {
        json(res, 200, { organization: registry.organization, login,
          person: registry.people.some(person => person.login === login),
          deployments: personDeployments(registry, login).map(({ id, profile, repository }) => ({ id, profile, repository })) })
        return
      }
      const native = nativePath.exec(url.pathname)
      if (native) {
        const target = findDeployment(registry, login, native[1]!)
        if (!target) throw new GatewayError(404, `Deployment not found: ${native[1]}`)
        await forwardNativeHttp(req, res, target)
        return
      }
      const deployment = deploymentPath.exec(url.pathname)
      if (deployment) {
        const target = findDeployment(registry, login, deployment[1]!)
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
  for (const deployment of registry === undefined ? [] : allDeployments(registry)) registerNativeRoute(deployment)
  return () => {
    for (const route of nativeRoutes.reverse()) {
      route.dispose()
      route.close()
    }
    disposeHttp()
  }
}
