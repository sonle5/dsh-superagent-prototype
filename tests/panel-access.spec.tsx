// @vitest-environment jsdom
import { expect, it, onTestFinished, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { click, field, mount, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const accessPage = () => at({ page: 'settings', query: { group: 'access' } })
const at = (route: object) => sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route, stack: [] }))

it('shows cloud identity, protected providers, and the effective deployment routes', async () => {
  server.gatewayStatus = {
    configured: true, url: 'https://superagent.example', organization: 'example-org', login: 'fixture-user', person: true,
  }
  server.settings.eval = { ...server.settings.eval, model: { provider: 'one-nexus', model: 'glm-5.3-sontinh' } }
  server.settings.executor = { ...server.settings.executor, model: { provider: 'claude', model: 'claude-opus-5-5(auto)' } }
  accessPage()
  await mount()
  expect(text()).toContain('@fixture-user')
  expect(text()).toContain('OneNexus')
  expect(text()).toContain('Claude')
  expect(text()).toContain('one-nexus / glm-5.3-sontinh')
  expect(text()).toContain('claude / claude-opus-5-5(auto)')
})

it('writes agent and model credentials without redisplaying them', async () => {
  server.gatewayStatus = {
    configured: true, url: 'https://superagent.example', organization: 'example-org', login: 'fixture-user', person: true,
  }
  accessPage()
  await mount()
  await type(field<HTMLInputElement>(zh.gatewayAgentToken), 'agent-token-value')
  await click(zh.accessAgentSave)
  expect(server.requests.find(request => request.path === 'gateway/deployment/inference-support-loop/credentials'))
    .toMatchObject({ method: 'POST', body: { githubToken: 'agent-token-value' } })

  await type(field<HTMLInputElement>(zh.accessProviderKey), 'sk-one-nexus-private')
  await click(zh.accessProviderSave)
  expect(server.requests.find(request => request.path === 'gateway/model-proxy/provider/one-nexus'))
    .toMatchObject({ method: 'PUT', body: { apiKey: 'sk-one-nexus-private' } })
  expect(text()).not.toContain('agent-token-value')
  expect(text()).not.toContain('sk-one-nexus-private')
})

it('protects the selected deployment and signs out only the local cloud session', async () => {
  server.gatewayStatus = {
    configured: true, url: 'https://superagent.example', organization: 'example-org', login: 'fixture-user', person: true,
  }
  accessPage()
  await mount()
  await click(zh.accessProtect)
  expect(server.requests).toContainEqual({ path: 'fleet/inference-support-loop/model-proxy', method: 'POST' })
  expect(JSON.stringify(server.providerControls['inference-support-loop'])).not.toContain('sk-')

  await click(zh.accessSignOut)
  expect(server.requests).toContainEqual({ path: 'gateway/session', method: 'DELETE' })
  expect(server.gatewayStatus.login).toBeUndefined()
})

it('opens one browser window for Claude and polls the existing callback listener flow', async () => {
  server.gatewayStatus = {
    configured: true, url: 'https://superagent.example', organization: 'example-org', login: 'fixture-user', person: true,
  }
  const opened = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() }
  vi.stubGlobal('open', vi.fn(() => opened))
  onTestFinished(() => { vi.unstubAllGlobals() })
  server.modelProxy.providers = server.modelProxy.providers.map(item => item.id === 'claude' ? { ...item, state: 'missing' } : item)
  accessPage()
  await mount()
  await click(zh.accessClaudeConnect)
  expect(opened.location.replace).toHaveBeenCalledWith('https://claude.example/authorize')
  expect(server.claudeLogin.state).toBe('waiting')
  expect(text()).toContain(zh.accessClaudeWaiting)
  server.claudeLogin = { state: 'connected' }
  await vi.waitFor(() => expect(text()).toContain(zh.accessClaudeLinked), { timeout: 3_500 })
})
