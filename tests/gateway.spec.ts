import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { registerGateway } from '../src/app/gateway.ts'
import { nativeToken } from '../src/app/native-auth.ts'

const DEVICE_URL = 'https://github.com/login/device/code'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'
const ORG_URL = 'https://api.github.com/orgs/example-org/members/member'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function listen(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void):
Promise<{ server: Server; url: string }> {
  const server = createServer(handler)
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

function gatewayFetch(member = true) {
  return vi.fn(async (url: string): Promise<Response> => {
    if (url === DEVICE_URL) return Response.json({ device_code: 'device-code', user_code: 'USER-1', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
    if (url === TOKEN_URL) return Response.json({ access_token: 'github-token' })
    if (url === USER_URL) return Response.json({ login: 'member' })
    if (url === ORG_URL) return new Response(null, { status: member ? 204 : 404 })
    throw new Error(`Unexpected URL: ${url}`)
  })
}

async function serveGateway(stateDir: string, fetcher: ReturnType<typeof gatewayFetch>) {
  let handler: ((request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>) | undefined
  registerGateway({
    webServer: {
      protocol: 'http:' as const,
      register: (route: { handler: typeof handler }) => { handler = route.handler; return () => { handler = undefined } },
    },
  } as never, stateDir, fetcher as never)
  const { server, url } = await listen((request, response) => {
    if (handler === undefined) throw new Error('Gateway route is not installed')
    void handler(request, response)
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
      stateDir: join(stateDir, 'sglang-state'), workspace: '/srv/work/sglang' }],
  }))
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
    login: 'member', organization: 'example-org',
    deployments: [{ id: 'sglang', profile: 'superagent-sglang', repository: 'example-org/sglang' }],
  } })
  expect(await gateway.call('GET', '/gateway/api/deployment/sglang/state', undefined, { cookie: cookie! }))
    .toMatchObject({ status: 200, body: { health: { runtime: { state: 'ready' } } } })
  expect(await gateway.call('GET', '/gateway/api/deployment/missing/state', undefined, { cookie: cookie! }))
    .toMatchObject({ status: 404, body: { error: 'Deployment not found: missing' } })
  expect(await gateway.call('GET', '/gateway/api/fleet', undefined, { cookie: cookie!, origin: 'https://evil.example' }))
    .toMatchObject({ status: 403, body: { error: 'Same-origin gateway request required' } })
  expect(fetcher).toHaveBeenCalledTimes(4)
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
