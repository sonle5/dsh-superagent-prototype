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
  expect(text()).toContain('Anthropic')
  expect(text()).toContain('alice@example.com')
  expect(text()).toContain(zh.accessAnthropicNotShared)
  expect(text()).toContain(zh.accessAnthropicAddAccount)
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
  await vi.waitFor(() => expect(server.requests).toContainEqual(
    { path: 'fleet/inference-support-loop/model-proxy/providers/one-nexus', method: 'POST' }))
  expect(text()).not.toContain('agent-token-value')
  expect(text()).not.toContain('sk-one-nexus-private')
})

it('warns about direct-key providers without a manual protect step, and signs out only the local cloud session', async () => {
  server.gatewayStatus = {
    configured: true, url: 'https://superagent.example', organization: 'example-org', login: 'fixture-user', person: true,
  }
  accessPage()
  await mount()
  expect(text()).toContain(zh.accessUnprotected.replace('{providers}', 'one-nexus'))
  expect(server.requests).not.toContainEqual({ path: 'fleet/inference-support-loop/model-proxy', method: 'POST' })

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
  server.modelProxy.providers = server.modelProxy.providers.map(item => item.id === 'claude' ? {
    ...item, state: 'auth-expired', expiresAt: '2026-01-01T00:00:00Z',
  } : item)
  accessPage()
  await mount()
  expect(text()).toContain(zh.accessClaudeReconnect)
  expect(text()).toContain(zh.accessAuthExpired.split('{expiresAt}')[0])
  await click(zh.accessClaudeReconnect)
  expect(opened.location.replace).toHaveBeenCalledWith('https://claude.example/authorize')
  expect(server.claudeLogin.state).toBe('waiting')
  expect(text()).toContain(zh.accessClaudeWaiting)
  server.claudeLogin = { state: 'connected' }
  server.modelProxy.providers = server.modelProxy.providers.map(item => item.id === 'claude' ? { ...item, state: 'connected' } : item)
  await vi.waitFor(() => expect(text()).toContain(zh.accessClaudeLinked), { timeout: 3_500 })
  await vi.waitFor(() => expect(server.requests).toContainEqual(
    { path: 'fleet/inference-support-loop/model-proxy/providers/claude', method: 'POST' }))
})
