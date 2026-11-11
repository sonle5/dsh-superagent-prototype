import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { registerControlHttp, registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { nativeToken } from '../src/app/native-auth.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(
  runtime: Partial<Record<keyof HttpHost, unknown>>,
  host = '127.0.0.1',
  requestRejection: () => number | undefined = () => undefined,
) {
  let handler: Handler = async () => {}
  const ctx = {
    webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } },
    connection: { requestRejection },
  }
  const machine = runtime.machine as Partial<HttpHost['machine']> | undefined
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime, machine: { stateDir: tmpdir(), ...machine } } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}
function serveControl(stateDir: string, host = '127.0.0.1', requestRejection: () => number | undefined = () => undefined) {
  let handler: Handler = async () => {}
  const ctx = {
    webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } },
    connection: { requestRejection },
  }
  registerControlHttp(ctx as never, stateDir)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('admits the panel session or the deployment native capability', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-management-auth-'))
  cleanup.push(() => { rmSync(state, { recursive: true, force: true }) })
  const token = nativeToken(state)!
  const call = serve({
    machine: { stateDir: state },
    sessions: { delivery: async () => 'injected' },
    engine: { unsubscribe: () => true },
  }, '127.0.0.1', () => 401)
  expect(await call('POST', 'threads/github%3A1/unsubscribe')).toEqual({ status: 401,
    body: { error: 'Signed-in management request required' } })
  expect(await call('POST', 'threads/github%3A1/unsubscribe', undefined, { 'x-dsh-superagent-native': token }))
    .toMatchObject({ status: 200 })
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

it('forwards management routes only to deployments registered in the local fleet', async () => {
  const seen: { method?: string; path?: string; orchestrator?: string; native?: string; body: string }[] = []
  const apiKeyField = ['api', 'key'].join('_')
  const target: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const path = request.url?.split('?')[0]
    seen.push({ method: request.method, path, orchestrator: request.headers['x-orchestrator-request'] as string | undefined,
      native: request.headers['x-dsh-superagent-native'] as string | undefined,
      body: Buffer.concat(chunks).toString('utf8') })
    if (path === '/orchestrator/api/settings/executor' && request.method === 'PUT') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ revision: 2, restarting: false }))
      return
    }
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
      error: `Request failed with Authorization: Bearer fixture-value and ${apiKeyField}=fixture-value`,
    }))
  })
  await new Promise<void>((resolve, reject) => {
    target.once('error', reject)
    target.listen(0, '127.0.0.1', resolve)
  })
  cleanup.push(() => { target.close() })
  const state = mkdtempSync(join(tmpdir(), 'dsh-fleet-proxy-'))
  cleanup.push(() => { rmSync(state, { recursive: true, force: true }) })
  const targetState = mkdtempSync(join(tmpdir(), 'dsh-fleet-proxy-target-'))
  cleanup.push(() => { rmSync(targetState, { recursive: true, force: true }) })
  const targetToken = nativeToken(targetState)!
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1,
    controlScript: '/usr/bin/true',
    logDir: state,
    deployments: [{
      id: 'sglang',
      profile: 'superagent-sglang',
      repository: 'onenexus-team/sglang',
      url: `http://127.0.0.1:${(target.address() as AddressInfo).port}`,
      stateDir: targetState,
      workspace: join(state, 'workspace'),
    }],
  }))
  const call = serveControl(state)

  expect(await call('GET', 'deployment/sglang/state')).toEqual({ status: 400, body: {
    error: 'Request failed with Authorization: Bearer [redacted] and api_key=[redacted]',
  } })
  expect(await call('PUT', 'deployment/sglang/settings/executor', { value: {}, revision: 1 })).toEqual({ status: 200,
    body: { revision: 2, restarting: false } })
  expect(seen).toEqual([
    { method: 'GET', path: '/orchestrator/api/state', orchestrator: '1', native: targetToken, body: '' },
    { method: 'PUT', path: '/orchestrator/api/settings/executor', orchestrator: '1', native: targetToken,
      body: '{"value":{},"revision":1}' },
  ])

  expect(await call('GET', 'deployment/missing/state')).toEqual({ status: 404,
    body: { error: 'Deployment not found: missing' } })
  expect(await call('GET', 'deployment/desktop/state')).toEqual({ status: 404,
    body: { error: 'Deployment not found: desktop' } })
  expect(await call('GET', 'deployment/sglang/fleet')).toEqual({ status: 404,
    body: { error: 'Unknown operation' } })
  expect(await call('GET', 'deployment/sglang/nothing/here')).toEqual({ status: 404,
    body: { error: 'Unknown operation' } })
  expect(seen).toHaveLength(2)
  expect(await call('POST', 'deployments/sglang/select')).toEqual({ status: 200, body: { selected: 'sglang' } })
  expect(await call('POST', 'deployments/missing/select')).toEqual({ status: 404,
    body: { error: 'Deployment not found: missing' } })
})

it('keeps the controller loopback-only and serves its registry without a local runtime', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-fleet-control-'))
  cleanup.push(() => { rmSync(state, { recursive: true, force: true }) })
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({ version: 1, deployments: [] }))
  const call = serveControl(state)
  expect(await call('GET', 'fleet')).toMatchObject({ status: 200, body: { deployments: [] } })
  expect(await call('GET', 'state')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(() => serveControl(state, '0.0.0.0')).toThrow('Fleet control requires a loopback Web server')
})

it('signs the Fleet controller in to a gateway and stores only the gateway session', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-gateway-controller-'))
  cleanup.push(() => { rmSync(state, { recursive: true, force: true }) })
  const gateway: Server = createServer(async (request, response) => {
    const body = await new Promise<string>(resolve => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(Buffer.from(chunk)))
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    if (request.url === '/gateway/api/device' && request.method === 'POST') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        device_code: 'device-code', user_code: 'USER-CODE', verification_uri: 'https://github.com/login/device',
        expires_in: 900, interval: 5,
      }))
      return
    }
    if (request.url === '/gateway/api/session' && request.method === 'POST') {
      if (JSON.parse(body).device_code !== 'device-code') {
        response.writeHead(202).end(JSON.stringify({ status: 'authorization_pending' }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        login: 'example-user', organization: 'example-org', expiresAt: '2099-01-01T00:00:00Z', nativeToken: 'gateway-session',
      }))
      return
    }
    if (request.url === '/gateway/api/fleet' && request.headers['x-dsh-superagent-native'] === 'gateway-session') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        organization: 'example-org', login: 'example-user', deployments: [],
      }))
      return
    }
    if (request.url === '/gateway/api/person' && request.method === 'POST'
      && request.headers['x-dsh-superagent-native'] === 'gateway-session') {
      response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({
        login: 'example-user', user: 'dsh-example-user', created: true,
      }))
      return
    }
    if (request.url === '/gateway/api/deployment' && request.method === 'POST'
      && request.headers['x-dsh-superagent-native'] === 'gateway-session' && JSON.parse(body).id === 'widgets') {
      response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({
        login: 'example-user', created: true,
        deployment: {
          id: 'widgets', profile: 'superagent-widgets', repository: 'example-org/widgets',
          url: 'http://127.0.0.1:3083', stateDir: '/var/lib/dsh-superagent/widgets',
          workspace: '/var/lib/dsh-superagent/worktrees/widgets',
        },
      }))
      return
    }
    if (request.url === '/gateway/api/deployment/widgets/credentials' && request.method === 'POST'
      && request.headers['x-dsh-superagent-native'] === 'gateway-session'
      && JSON.parse(body).githubToken === 'agent-github-token-1234') {
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ saved: true, revision: 8, restarting: true }))
      return
    }
    response.writeHead(500).end(JSON.stringify({ error: `Unexpected gateway path: ${request.url}` }))
  })
  await new Promise<void>((resolve, reject) => {
    gateway.once('error', reject)
    gateway.listen(0, '127.0.0.1', resolve)
  })
  cleanup.push(() => { gateway.close() })
  writeFileSync(join(state, 'gateway.json'), JSON.stringify({
    version: 1, url: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`, token: 'stale-session',
  }), { mode: 0o600 })
  const call = serveControl(state)

  expect(await call('GET', 'gateway/status')).toMatchObject({ status: 200, body: {
    configured: true, error: 'Gateway fleet is unavailable: Unexpected gateway path: /gateway/api/fleet',
  } })
  expect(await call('POST', 'gateway/device')).toEqual({ status: 200, body: {
    device_code: 'device-code', user_code: 'USER-CODE', verification_uri: 'https://github.com/login/device',
    expires_in: 900, interval: 5,
  } })
  expect(await call('POST', 'gateway/session', { device_code: 'wrong' })).toEqual({ status: 502, body: {
    error: 'Gateway sign-in failed: authorization_pending',
  } })
  expect(await call('POST', 'gateway/session', { device_code: 'device-code' })).toEqual({ status: 200, body: {
    login: 'example-user', organization: 'example-org', expiresAt: '2099-01-01T00:00:00Z',
  } })
  expect(JSON.parse(readFileSync(join(state, 'gateway.json'), 'utf8'))).toEqual({
    version: 1, url: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`, token: 'gateway-session',
  })
  expect(await call('GET', 'gateway/status')).toEqual({ status: 200, body: {
    configured: true, url: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
    organization: 'example-org', login: 'example-user',
  } })
  expect(await call('POST', 'gateway/person')).toEqual({ status: 200, body: {
    login: 'example-user', user: 'dsh-example-user', created: true,
  } })
  expect(await call('POST', 'gateway/deployment', { id: 'widgets', repository: 'example-org/widgets' }))
    .toEqual({ status: 200, body: {
      login: 'example-user', created: true,
      deployment: {
        id: 'widgets', profile: 'superagent-widgets', repository: 'example-org/widgets',
        url: 'http://127.0.0.1:3083', stateDir: '/var/lib/dsh-superagent/widgets',
        workspace: '/var/lib/dsh-superagent/worktrees/widgets',
      },
    } })
  expect(await call('POST', 'gateway/deployment/widgets/credentials', { githubToken: 'agent-github-token-1234' }))
    .toEqual({ status: 200, body: { saved: true, revision: 8, restarting: true } })
  expect(readFileSync(join(state, 'gateway.json'), 'utf8')).not.toContain('agent-github-token-1234')
})
