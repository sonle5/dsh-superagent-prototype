import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { WebSocketServer } from 'ws'
import { registerGateway } from '../src/app/gateway.ts'
import { nativeToken } from '../src/app/native-auth.ts'

const DEVICE_URL = 'https://github.com/login/device/code'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'
const PRIVATE_CONTROL_VALUE = ['private', 'control', 'value'].join('-')
const PRIVATE_LOG_VALUE = ['private', 'log', 'value'].join('-')
const PRIVATE_QUERY_VALUE = ['private', 'query', 'value'].join('-')

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>

async function listen(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void):
Promise<{ server: Server; url: string }> {
  const server = createServer(handler)
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

function gatewayFetch(member = true, login = 'member') {
  const orgUrl = `https://api.github.com/orgs/example-org/members/${login}`
  return vi.fn(async (url: string): Promise<Response> => {
    if (url === DEVICE_URL) return Response.json({ device_code: 'device-code', user_code: 'USER-1', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
    if (url === TOKEN_URL) return Response.json({ access_token: 'github-token' })
    if (url === USER_URL) return Response.json({ login })
    if (url === orgUrl) return new Response(null, { status: member ? 204 : 404 })
    throw new Error(`Unexpected URL: ${url}`)
  })
}

async function serveGateway(stateDir: string, fetcher: ReturnType<typeof gatewayFetch>) {
  let handler: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined
  const upgrades = new Map<string, UpgradeHandler>()
  registerGateway({
    webServer: {
      protocol: 'http:' as const,
      register: (route: { handler: typeof handler }) => { handler = route.handler; return () => { handler = undefined } },
      registerUpgrade: (route: { path: string; handler: UpgradeHandler }) => {
        upgrades.set(route.path, route.handler)
        return () => upgrades.delete(route.path)
      },
    },
  } as never, stateDir, fetcher as never)
  const { server, url } = await listen((request, response) => {
    if (handler === undefined) throw new Error('Gateway route is not installed')
    void handler(request, response)
  })
  server.on('upgrade', (request, socket, head) => {
    const upgrade = upgrades.get(new URL(request.url ?? '/', url).pathname)
    if (upgrade === undefined) {
      socket.destroy()
      return
    }
    void upgrade(request, socket, head)
  })
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}${path}`, { method, headers, ...body === undefined ? {} : {
      body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers },
    } })
    return { status: response.status, setCookie: response.headers.get('set-cookie'), body: await response.json() }
  }
  return { server, url, call }
}

function registry(stateDir: string, deploymentUrl: string): void {
  writeFileSync(join(stateDir, 'gateway.json'), JSON.stringify({
    version: 1, organization: 'example-org', githubClientId: 'a'.repeat(20),
    deployments: [{ id: 'sglang', profile: 'superagent-sglang', repository: 'example-org/sglang', url: deploymentUrl,
      stateDir: join(stateDir, 'sglang-state'), workspace: '/srv/work/sglang', ownerLogin: 'member' }],
  }))
}

function onboardingRegistry(stateDir: string, helper: string, legacyUrl: string): void {
  writeFileSync(join(stateDir, 'gateway.json'), JSON.stringify({
    version: 1, organization: 'example-org', githubClientId: 'a'.repeat(20), people: [],
    onboarding: {
      command: [helper], gatewayUser: 'gateway-user', gatewayGroup: 'gateway-group',
      checkout: '/opt/dsh-superagent', baseDir: '/var/lib/dsh-superagent',
      modelProxy: { binary: '/opt/cliproxyapi/cli-proxy-api', portRange: { start: 8317, end: 9316 } },
    },
    deployments: [{ id: 'legacy', profile: 'superagent-legacy', repository: 'example-org/legacy', url: legacyUrl,
      stateDir: join(stateDir, 'legacy-state'), workspace: '/srv/work/legacy', ownerLogin: 'other-owner' }],
  }))
}

function onboardingHelper(state: string, deploymentUrl: string): string {
  const path = join(state, 'onboard')
  const requestsPath = join(state, 'onboard-requests')
  writeFileSync(path, `#!/usr/bin/env python3
import json
import sys
import time
request = json.load(__file__ and open(0))
print('pam warning', file=sys.stderr)
with open(${JSON.stringify(requestsPath)}, 'a') as record:
    record.write(json.dumps(request) + '\\n')
if request['operation'] == 'person':
    print(json.dumps({'user': 'dsh-member', 'home': '/var/lib/dsh-superagent/people/member'}))
elif request['operation'] == 'deployment':
    print(json.dumps({
        'id': 'widgets', 'profile': 'superagent-widgets', 'repository': 'example-org/widgets',
        'url': ${JSON.stringify(deploymentUrl)}, 'stateDir': '/var/lib/dsh-superagent/people/member/deployments/widgets',
        'workspace': '/var/lib/dsh-superagent/people/member/worktrees/widgets',
        'tokenDir': ${JSON.stringify(join(state, 'gateway-tokens'))},
    }))
elif request['operation'] == 'credentials':
    print(json.dumps({'id': request['id'], 'cli': ${JSON.stringify(join(state, 'agent-widgets'))}}))
elif request['operation'] == 'lifecycle':
    time.sleep(0.25)
    print(json.dumps({
        'id': request['id'], 'action': request['action'], 'state': 'active',
        'output': 'Authorization: ' + 'Bearer ' + ${JSON.stringify(PRIVATE_CONTROL_VALUE)},
    }))
elif request['operation'] == 'status':
    print(json.dumps({'id': request['id'], 'state': 'inactive'}))
elif request['operation'] == 'logs':
    print(json.dumps({
        'id': request['id'], 'state': 'inactive',
        'tail': 'last line\\nAuthorization: ' + 'Bearer ' + ${JSON.stringify(PRIVATE_LOG_VALUE)}
          + '\\nhttps://example.test/?token=' + ${JSON.stringify(PRIVATE_QUERY_VALUE)},
    }))
elif request['operation'] == 'model-proxy':
    action = request['action']
    if action == 'status':
        print(json.dumps({
            'status': 'ready', 'baseURL': 'http://127.0.0.1:8317/v1',
            'providers': [
                {'id': 'claude', 'label': 'Claude', 'state': 'connected'},
                {'id': 'one-nexus', 'label': 'OneNexus', 'state': 'configured'},
            ],
            'deployments': [{'id': item, 'keyConfigured': True} for item in request['deploymentIds']],
        }))
    elif action == 'claude-start':
        print(json.dumps({
            'url': 'https://claude.example/authorize', 'state': 'a' * 24,
            'expiresAt': '2099-01-01T00:05:00Z',
        }))
    elif action == 'claude-status':
        print(json.dumps({'status': 'ok'}))
    elif action == 'claude-callback':
        print(json.dumps({'accepted': True}))
    elif action == 'claude-cancel':
        print(json.dumps({'cancelled': True}))
    elif action == 'provider-key-set':
        print(json.dumps({'provider': request['provider'], 'configured': True}))
    elif action == 'deployment-key-create':
        print(json.dumps({'id': request['id'], 'value': 'dsh-' + request['id'] + '-private-proxy-key'}))
    elif action == 'deployment-key-revoke':
        print(json.dumps({'id': request['id'], 'revoked': True}))
    elif action == 'deployment-key-prune':
        print(json.dumps({'id': request['id'], 'pruned': True}))
    else:
        print(json.dumps({'status': 'accepted'}))
`, { mode: 0o755 })
  return path
}

it('signs in a GitHub organization member and forwards one deployment management route', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-gateway-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const deploymentState = join(state, 'sglang-state')
  const token = nativeToken(deploymentState)!
  const target = await listen((request, response) => {
    if (request.url !== '/orchestrator/api/state'
      || request.headers['x-orchestrator-request'] !== '1'
      || request.headers['x-dsh-superagent-native'] !== token) {
      response.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    response.writeHead(200).end(JSON.stringify({ setup: { problem: null }, health: { runtime: { state: 'ready', detail: '' } } }))
  })
  registry(state, target.url)
  const fetcher = gatewayFetch()
  const gateway = await serveGateway(state, fetcher)

  const device = await gateway.call('POST', '/gateway/api/device')
  expect(device).toMatchObject({ status: 200, body: { device_code: 'device-code', user_code: 'USER-1' } })
  const session = await gateway.call('POST', '/gateway/api/session', { device_code: 'device-code' })
  expect(session.status).toBe(200)
  expect(session.body).toMatchObject({ login: 'member', organization: 'example-org' })
  const cookie = session.setCookie?.split(';', 1)[0]
  expect(cookie).toMatch(/^dsh-superagent-gateway=member\.\d+\./)

  expect(await gateway.call('GET', '/gateway/api/fleet')).toMatchObject({ status: 401, body: { error: 'Gateway sign-in required' } })
  expect(await gateway.call('GET', '/gateway/api/fleet', undefined, { cookie: cookie! })).toMatchObject({ status: 200, body: {
    login: 'member', organization: 'example-org', person: false,
    deployments: [{ id: 'sglang', profile: 'superagent-sglang', repository: 'example-org/sglang', capabilities: [] }],
  } })
  expect(await gateway.call('GET', '/gateway/api/deployment/sglang/state', undefined, { cookie: cookie! }))
    .toMatchObject({ status: 200, body: { health: { runtime: { state: 'ready' } } } })
  expect(await gateway.call('GET', '/gateway/api/deployment/missing/state', undefined, { cookie: cookie! }))
    .toMatchObject({ status: 404, body: { error: 'Deployment not found: missing' } })
  expect(await gateway.call('GET', '/gateway/api/fleet', undefined, { cookie: cookie!, origin: 'https://evil.example' }))
    .toMatchObject({ status: 403, body: { error: 'Same-origin gateway request required' } })
  expect(fetcher).toHaveBeenCalledTimes(4)
})

it('forwards native API and WebSocket traffic through one deployment route', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-gateway-native-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const deploymentState = join(state, 'sglang-state')
  const deploymentToken = nativeToken(deploymentState)!
  const seen: { path?: string; host?: string; origin?: string; native?: string }[] = []
  const target = await listen((request, response) => {
    const native = request.headers['x-dsh-superagent-native']
    seen.push({ path: request.url, host: request.headers.host, origin: request.headers.origin,
      native: typeof native === 'string' ? native : native?.[0] })
    if (request.url !== '/orchestrator/native/api/session/list?limit=20' || request.headers['x-orchestrator-request'] !== '1'
      || request.headers['x-dsh-superagent-native'] !== deploymentToken) {
      response.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'native', ok: true }))
  })
  const targetWss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  cleanup.push(() => new Promise<void>(resolve => targetWss.close(() => resolve())))
  target.server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/orchestrator/native/remote.mux' || request.headers['x-orchestrator-request'] !== '1'
      || request.headers['x-dsh-superagent-native'] !== deploymentToken) {
      socket.destroy()
      return
    }
    targetWss.handleUpgrade(request, socket, head, client => {
      client.send('upstream-ready')
      client.on('message', data => client.send(`echo:${data.toString()}`))
    })
  })
  registry(state, target.url)
  const gateway = await serveGateway(state, gatewayFetch())

  await gateway.call('POST', '/gateway/api/device')
  const session = await gateway.call('POST', '/gateway/api/session', { device_code: 'device-code' })
  const gatewayToken = session.body.nativeToken as string
  expect(gatewayToken).toMatch(/^member\.\d+\./)
  expect(await gateway.call('POST', '/gateway/native/sglang/api/session/list?limit=20', { method: 'session/list' }))
    .toMatchObject({ status: 401 })
  const native = await gateway.call('POST', '/gateway/native/sglang/api/session/list?limit=20', { method: 'session/list' }, {
    'x-dsh-superagent-native': gatewayToken,
  })
  expect(native).toMatchObject({ status: 200, body: { type: 'native', ok: true } })
  expect(seen).toEqual([{ path: '/orchestrator/native/api/session/list?limit=20', host: new URL(target.url).host, origin: target.url,
    native: deploymentToken }])

  const socket = new WebSocket(`${gateway.url.replace('http:', 'ws:')}/gateway/native/sglang/remote.mux`, {
    headers: { 'x-dsh-superagent-native': gatewayToken },
  })
  cleanup.push(() => socket.terminate())
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const firstFrame = (): Promise<{ data: string; binary: boolean }> => new Promise(resolve => socket.once('message', (data, binary) => {
    resolve({ data: data.toString(), binary })
  }))
  await expect(firstFrame()).resolves.toEqual({ data: 'upstream-ready', binary: false })
  socket.send('hello')
  await expect(firstFrame()).resolves.toEqual({ data: 'echo:hello', binary: false })

  const otherGateway = await serveGateway(state, gatewayFetch(true, 'other-member'))
  await otherGateway.call('POST', '/gateway/api/device')
  const otherSession = await otherGateway.call('POST', '/gateway/api/session', { device_code: 'device-code' })
  const otherToken = otherSession.body.nativeToken as string
  const otherSocket = new WebSocket(`${otherGateway.url.replace('http:', 'ws:')}/gateway/native/widgets/remote.mux`, {
    headers: { 'x-dsh-superagent-native': otherToken },
  })
  cleanup.push(() => otherSocket.terminate())
  const outcome = await new Promise<'open' | 'error'>(resolve => {
    otherSocket.once('open', () => resolve('open'))
    otherSocket.once('error', () => resolve('error'))
  })
  expect(outcome).toBe('error')
})

it('refuses a GitHub account outside the configured organization without a session', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-gateway-member-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  registry(state, 'http://127.0.0.1:9')
  const gateway = await serveGateway(state, gatewayFetch(false))
  await gateway.call('POST', '/gateway/api/device')
  const session = await gateway.call('POST', '/gateway/api/session', { device_code: 'device-code' })
  expect(session).toMatchObject({ status: 403, setCookie: null, body: { error: 'GitHub account is not a member of example-org' } })
})

it('keeps model-provider operations behind the trusted controller and never returns write-only secrets', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-gateway-model-proxy-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const helper = onboardingHelper(state, 'http://127.0.0.1:10')
  onboardingRegistry(state, helper, 'http://127.0.0.1:9')
  const gateway = await serveGateway(state, gatewayFetch())
  await gateway.call('POST', '/gateway/api/device')
  const session = await gateway.call('POST', '/gateway/api/session', { device_code: 'device-code' })
  const cookie = session.setCookie!.split(';', 1)[0]!
  await gateway.call('POST', '/gateway/api/person', undefined, { cookie })
  const deployment = await gateway.call('POST', '/gateway/api/deployment', {
    id: 'widgets', repository: 'example-org/widgets',
  }, { cookie })
  expect(deployment.status).toBe(201)
  expect(await gateway.call('GET', '/gateway/api/model-proxy', undefined, { cookie })).toMatchObject({
    status: 403, body: { error: 'Trusted controller request required' },
  })
  const native = session.body.nativeToken as string
  const status = await gateway.call('GET', '/gateway/api/model-proxy', undefined, { cookie, 'x-dsh-superagent-native': native })
  expect(status).toMatchObject({ status: 200, body: { baseURL: 'http://127.0.0.1:8317/v1',
    deployments: [{ id: 'widgets', keyConfigured: true }] } })
  expect(JSON.stringify(status.body)).not.toContain('private-proxy-key')

  const key = await gateway.call('PUT', '/gateway/api/model-proxy/provider/one-nexus', {
    apiKey: 'sk-one-nexus-write-only',
  }, { cookie, 'x-dsh-superagent-native': native })
  expect(key).toMatchObject({ status: 200, body: { provider: 'one-nexus', configured: true } })
  expect(JSON.stringify(key.body)).not.toContain('sk-one-nexus-write-only')
  expect(JSON.stringify(JSON.parse(readFileSync(join(state, 'gateway.json'), 'utf8')))).not.toContain('sk-one-nexus-write-only')

  const created = await gateway.call('POST', '/gateway/api/model-proxy/deployment/widgets/key', undefined,
    { cookie, 'x-dsh-superagent-native': native })
  expect(created).toMatchObject({ status: 201, body: { id: 'widgets', value: 'dsh-widgets-private-proxy-key' } })
  expect(await gateway.call('DELETE', '/gateway/api/model-proxy/deployment/widgets/key',
    { value: created.body.value }, { cookie, 'x-dsh-superagent-native': native }))
    .toMatchObject({ status: 200, body: { id: 'widgets', revoked: true } })
  expect(await gateway.call('POST', '/gateway/api/model-proxy/deployment/widgets/key/finalize',
    { keep: 'dsh-widgets-new-private-proxy-key' }, { cookie, 'x-dsh-superagent-native': native }))
    .toMatchObject({ status: 200, body: { id: 'widgets', pruned: true } })
  expect(JSON.stringify(JSON.parse(readFileSync(join(state, 'gateway.json'), 'utf8')))).not.toContain('dsh-widgets-private-proxy-key')
})

it('onboards a person and deployment without exposing another person’s registry', async () => {
  const state = mkdtempSync(join(tmpdir(), 'dsh-gateway-onboard-'))
  cleanup.push(() => rmSync(state, { recursive: true, force: true }))
  const tokenDir = join(state, 'gateway-tokens')
  const deploymentToken = nativeToken(tokenDir)!
  const seen: { path?: string; native?: string }[] = []
  const savedSettings: { revision: number; value: { enabled: boolean; config: Record<string, unknown> } }[] = []
  const target = await listen((request, response) => {
    const native = request.headers['x-dsh-superagent-native']
    seen.push({ path: request.url, native: typeof native === 'string' ? native : native?.[0] })
    if (request.method === 'GET' && request.url === '/orchestrator/api/settings') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        sources: [{ id: 'github', revision: 7, value: { enabled: true, config: {
          repository: 'example-org/old', cli: '/old/gh-agent', observeIssues: true,
        } } }],
      }))
      return
    }
    if (request.method === 'PUT' && request.url === '/orchestrator/api/settings/source:github') {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        savedSettings.push(JSON.parse(body))
        response.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ saved: true, revision: 8, restarting: true }))
      })
      return
    }
    if (request.url !== '/orchestrator/api/state' || request.headers['x-dsh-superagent-native'] !== deploymentToken) {
      response.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    response.writeHead(200).end(JSON.stringify({ setup: { problem: null }, health: { runtime: { state: 'ready', detail: '' } } }))
  })
  const targetWss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  cleanup.push(() => new Promise<void>(resolve => targetWss.close(() => resolve())))
  target.server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/orchestrator/native/remote.mux' || request.headers['x-dsh-superagent-native'] !== deploymentToken) {
      socket.destroy()
      return
    }
    targetWss.handleUpgrade(request, socket, head, client => {
      client.on('message', data => client.send(`echo:${data.toString()}`))
    })
  })
  const helper = onboardingHelper(state, target.url)
  onboardingRegistry(state, helper, 'http://127.0.0.1:9')
  const gateway = await serveGateway(state, gatewayFetch())

  await gateway.call('POST', '/gateway/api/device')
  const session = await gateway.call('POST', '/gateway/api/session', { device_code: 'device-code' })
  const gatewayToken = session.body.nativeToken as string
  const cookie = session.setCookie?.split(';', 1)[0]

  expect(await gateway.call('GET', '/gateway/api/fleet', undefined, { cookie: cookie! })).toMatchObject({
    status: 200, body: { login: 'member', person: false, deployments: [] },
  })
  expect(await gateway.call('GET', '/gateway/api/deployment/legacy/state', undefined, { cookie: cookie! }))
    .toMatchObject({ status: 404, body: { error: 'Deployment not found: legacy' } })

  const person = await gateway.call('POST', '/gateway/api/person', undefined, { cookie: cookie! })
  expect(person).toMatchObject({ status: 201, body: { login: 'member', user: 'dsh-member', created: true } })
  expect(await gateway.call('POST', '/gateway/api/person', undefined, { cookie: cookie! }))
    .toMatchObject({ status: 200, body: { login: 'member', created: false } })
  const deployment = await gateway.call('POST', '/gateway/api/deployment', {
    id: 'widgets', repository: 'example-org/widgets',
  }, { cookie: cookie! })
  expect(deployment).toMatchObject({ status: 201, body: {
    login: 'member',
    deployment: { id: 'widgets', profile: 'superagent-widgets', repository: 'example-org/widgets' },
  } })
  expect(deployment.body).not.toHaveProperty('tokenDir')
  expect(JSON.stringify(deployment.body)).not.toContain('agent-github-token-1234')
  const saved = JSON.parse(readFileSync(join(state, 'gateway.json'), 'utf8')) as {
    people: { login: string; deployments: { id: string; tokenDir: string }[] }[]
  }
  expect(saved.people).toEqual([expect.objectContaining({ login: 'member' })])
  expect(saved.people[0]?.deployments[0]).toMatchObject({ id: 'widgets', tokenDir })

  expect(await gateway.call('POST', '/gateway/api/deployment/widgets/lifecycle', { action: 'stop' }))
    .toMatchObject({ status: 401, body: { error: 'Gateway sign-in required' } })
  expect(await gateway.call('POST', '/gateway/api/deployment/widgets/lifecycle', { action: 'explode' }, { cookie: cookie! }))
    .toMatchObject({ status: 400 })
  const lifecycle = await Promise.all([
    gateway.call('POST', '/gateway/api/deployment/widgets/lifecycle', { action: 'restart' }, { cookie: cookie! }),
    gateway.call('POST', '/gateway/api/deployment/widgets/lifecycle', { action: 'restart' }, { cookie: cookie! }),
  ])
  expect(lifecycle.map(result => result.status).sort()).toEqual([200, 409])
  const completed = lifecycle.find(result => result.status === 200)!
  expect(completed.body).toMatchObject({ id: 'widgets', action: 'restart', state: 'active' })
  expect(completed.body.output).toContain('Authorization: Bearer [redacted]')
  expect(JSON.stringify(completed.body)).not.toContain(PRIVATE_CONTROL_VALUE)
  expect(await gateway.call('GET', '/gateway/api/deployment/widgets/status', undefined, { cookie: cookie! }))
    .toMatchObject({ status: 200, body: { id: 'widgets', state: 'inactive' } })
  const logs = await gateway.call('GET', '/gateway/api/deployment/widgets/logs?lines=80', undefined, { cookie: cookie! })
  expect(logs).toMatchObject({ status: 200, body: { id: 'widgets', state: 'inactive' } })
  expect(logs.body.tail).toContain('last line')
  expect(logs.body.tail).toContain('Authorization: Bearer [redacted]')
  expect(logs.body.tail).toContain('token=[redacted]')
  expect(JSON.stringify(logs.body)).not.toContain(PRIVATE_LOG_VALUE)
  expect(JSON.stringify(logs.body)).not.toContain(PRIVATE_QUERY_VALUE)

  const auditPath = join(state, 'audit.jsonl')
  expect(statSync(auditPath).mode & 0o777).toBe(0o600)
  const audit = readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  expect(audit).toEqual([
    expect.objectContaining({ phase: 'attempt', login: 'member', deployment: 'widgets', action: 'restart' }),
    expect.objectContaining({ phase: 'result', login: 'member', deployment: 'widgets', action: 'restart', outcome: 'succeeded' }),
  ])
  expect(JSON.stringify(audit)).not.toContain(PRIVATE_CONTROL_VALUE)

  expect(await gateway.call('GET', '/gateway/api/fleet', undefined, { cookie: cookie! })).toMatchObject({
    status: 200, body: { login: 'member', person: true, deployments: [
      { id: 'widgets', profile: 'superagent-widgets', repository: 'example-org/widgets',
        capabilities: ['lifecycle', 'logs'] },
    ] },
  })
  expect(await gateway.call('GET', '/gateway/api/deployment/widgets/state', undefined, { cookie: cookie! }))
    .toMatchObject({ status: 200, body: { health: { runtime: { state: 'ready' } } } })
  expect(seen).toEqual([{ path: '/orchestrator/api/state', native: deploymentToken }])
  expect(await gateway.call('GET', '/gateway/api/deployment/legacy/state', undefined, { cookie: cookie! }))
    .toMatchObject({ status: 404, body: { error: 'Deployment not found: legacy' } })
  expect(await gateway.call('POST', '/gateway/api/deployment', {
    id: 'widgets', repository: 'example-org/widgets',
  }, { cookie: cookie! })).toMatchObject({ status: 409, body: { error: 'Deployment id already exists: widgets' } })
  expect(JSON.stringify(JSON.parse(readFileSync(join(state, 'gateway.json'), 'utf8')))).not.toContain('agent-github-token')

  const credentials = await gateway.call('POST', '/gateway/api/deployment/widgets/credentials', {
    githubToken: 'agent-github-token-1234',
  }, { cookie: cookie! })
  expect(credentials).toMatchObject({ status: 200, body: { saved: true, revision: 8, restarting: true } })
  expect(credentials.body).not.toHaveProperty('githubToken')
  expect(savedSettings).toEqual([{ revision: 7, value: {
    enabled: true,
    config: {
      repository: 'example-org/widgets', cli: join(state, 'agent-widgets'), observeIssues: true,
    },
  } }])
  const helperRequests = readFileSync(join(state, 'onboard-requests'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as {
    operation: string; githubToken?: string
  })
  expect(helperRequests.at(-1)).toMatchObject({
    operation: 'credentials', login: 'member', id: 'widgets', githubToken: 'agent-github-token-1234',
  })
  expect(JSON.stringify(JSON.parse(readFileSync(join(state, 'gateway.json'), 'utf8')))).not.toContain('agent-github-token')

  const socket = new WebSocket(`${gateway.url.replace('http:', 'ws:')}/gateway/native/widgets/remote.mux`, {
    headers: { 'x-dsh-superagent-native': gatewayToken },
  })
  cleanup.push(() => socket.terminate())
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.send('hello')
  await expect(new Promise<string>(resolve => socket.once('message', data => resolve(data.toString()))))
    .resolves.toBe('echo:hello')

  const otherGateway = await serveGateway(state, gatewayFetch(true, 'other-member'))
  await otherGateway.call('POST', '/gateway/api/device')
  const otherSession = await otherGateway.call('POST', '/gateway/api/session', { device_code: 'device-code' })
  const otherCookie = otherSession.setCookie?.split(';', 1)[0]
  expect(await otherGateway.call('POST', '/gateway/api/deployment/widgets/lifecycle', { action: 'stop' },
    { cookie: otherCookie! })).toMatchObject({ status: 404, body: { error: 'Deployment not found: widgets' } })
  expect(await gateway.call('GET', '/gateway/api/deployment/widgets/logs?lines=81', undefined, { cookie: cookie! }))
    .toMatchObject({ status: 400 })
})
