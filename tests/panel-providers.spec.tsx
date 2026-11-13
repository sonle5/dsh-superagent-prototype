// @vitest-environment jsdom
// Deployment-scoped provider, credential, and model management.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { all, at, click, field, find, mount, settle, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const providersPage = () => at({ page: 'settings', query: { group: 'providers' } })
const card = (name: string) => all('.dt-provider-card').find(item => item.querySelector('.dt-card-title')?.textContent === name)!
const modalField = (label: string) => {
  const modal = document.querySelector<HTMLElement>('.dt-provider-modal')!
  const match = [...modal.querySelectorAll<HTMLElement>('input, select, textarea')].find(element =>
    element.getAttribute('aria-label') === label
      || !!element.id && [...modal.querySelectorAll('label')].some(item => (item as HTMLLabelElement).htmlFor === element.id
        && item.textContent === label))
  if (!match) throw new Error(`No provider field ${label}`)
  return match as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
}
async function completeProvider(id: string, name: string, key: string) {
  await type(modalField(zh.providerId), id)
  await type(modalField(zh.providerName), name)
  await type(modalField(zh.providerBaseURL), 'https://api.example.test/v1')
  await type(modalField(zh.providerCredentialRef), 'EXAMPLE_API_KEY')
  await type(modalField(zh.providerKey), key)
  await type(modalField(zh.providerModelId), 'example-model')
  await type(modalField(zh.providerModelName), 'Example Model')
  await type(modalField(zh.providerContextWindow), '128000')
  await type(modalField(zh.providerMaxTokens), '32000')
}

it('lists deployment providers with redacted credential state and model capabilities', async () => {
  providersPage()
  await mount()
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.providers'])
  expect(all('.dt-provider-card .dt-card-title').map(item => item.textContent)).toEqual(['One Nexus', 'Claude'])
  expect(text()).toContain('Claude Opus 5.5')
  expect(text()).toContain('GLM 5.3')
  expect(text()).toContain(zh.providerKeyConfigured)
  expect(text()).toContain('CLAUDE_API_KEY')
  expect(text()).not.toContain('sk-secret')
})

it('adds a provider with a write-only key and refreshes the selected deployment', async () => {
  providersPage()
  await mount()
  await click(zh.providerAdd)
  await completeProvider('example', 'Example Provider', 'sk-secret-provider-key')
  await click(find(zh.save))
  expect(server.requests.find(request => request.path === 'fleet/inference-support-loop/providers/example')).toMatchObject({
    method: 'PUT',
    body: { displayName: 'Example Provider', credentialRef: 'EXAMPLE_API_KEY', apiKey: 'sk-secret-provider-key',
      models: [{ id: 'example-model', name: 'Example Model', contextWindow: 128000, maxTokens: 32000, reasoning: false, image: false }] },
  })
  const added = server.providerControls['inference-support-loop']!.providers.find(item => item.id === 'example')!
  expect(added.credential).toEqual({ configured: true, source: 'user', writable: true })
  expect(JSON.stringify(server.providerControls['inference-support-loop'])).not.toContain('sk-secret-provider-key')
  expect(text()).toContain('Example Provider')
  expect(text()).not.toContain('sk-secret-provider-key')
})

it('keeps the editor open on a revision conflict and reports the refusal', async () => {
  providersPage()
  await mount()
  await click(zh.providerAdd)
  await completeProvider('example', 'Example Provider', 'sk-secret-provider-key')
  server.providerControls['inference-support-loop']!.revision++
  await click(find(zh.save))
  expect(document.querySelector('.dt-provider-modal [role="alert"]')?.textContent).toContain('Settings changed')
  expect(document.querySelector('.dt-provider-modal')).not.toBeNull()
})

it('replaces a credential without echoing it and resets only a deployment override', async () => {
  providersPage()
  await mount()
  const claude = card('Claude')
  await click([...claude.querySelectorAll<HTMLElement>('button')].find(button => button.textContent === zh.providerReplaceKey)!)
  await type(document.querySelector<HTMLInputElement>('#dt-provider-credential input')!, 'sk-new-claude-key')
  await click(document.querySelector<HTMLButtonElement>('button[form="dt-provider-credential"]')!)
  expect(server.requests.find(request => request.path === 'fleet/inference-support-loop/providers/claude/credential'))
    .toMatchObject({ method: 'POST', body: { value: 'sk-new-claude-key' } })
  expect(text()).not.toContain('sk-new-claude-key')

  const oneNexus = card('One Nexus')
  await click([...oneNexus.querySelectorAll<HTMLElement>('button')].find(button => button.textContent === zh.providerReset)!)
  await click(find(zh.confirm))
  expect(server.providerControls['inference-support-loop']!.providers.some(item => item.id === 'one-nexus')).toBe(false)
  expect(server.providerControls.sglang!.providers.some(item => item.id === 'one-nexus')).toBe(true)
})

it('keeps provider edits isolated when Desktop switches deployments', async () => {
  providersPage()
  await mount()
  await click(zh.providerAdd)
  await completeProvider('inference-only', 'Inference only', 'sk-inference-only')
  await click(find(zh.save))
  expect(text()).toContain('Inference only')

  await type(field<HTMLSelectElement>(zh.deploymentContext), 'sglang')
  expect(text()).not.toContain('Inference only')
  expect(server.providerControls['inference-support-loop']!.providers.some(item => item.id === 'inference-only')).toBe(true)
  expect(server.providerControls.sglang!.providers.some(item => item.id === 'inference-only')).toBe(false)

  await type(field<HTMLSelectElement>(zh.deploymentContext), 'inference-support-loop')
  await settle()
  expect(text()).toContain('Inference only')
})
