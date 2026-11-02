// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { all, click, field, find, mount, remount, tab, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

it('shows every peer deployment with equal lifecycle and management controls', async () => {
  await mount()
  await click(tab(zh['tab.fleet']))
  expect(tab(zh['tab.fleet']).getAttribute('aria-selected')).toBe('true')
  expect(all('.dt-fleet-card').map(card => card.getAttribute('data-status'))).toEqual(['ready', 'stopped'])
  expect(text()).toContain('onenexus-team/inference-support-loop')
  expect(text()).toContain('onenexus-team/sglang')
  expect(text()).toContain('/Users/alice/src/sglang-superagent')
  expect([...all('.dt-fleet-card')[0]!.querySelectorAll('button')].map(button => button.textContent)).toEqual([zh.fleetStop,
    zh.fleetRestart, zh.fleetManage])
  expect([...all('.dt-fleet-card')[1]!.querySelectorAll('button')].map(button => button.textContent)).toEqual([zh.fleetStart,
    zh.fleetManage])
})

it('starts a stopped deployment and refreshes its aggregate state', async () => {
  await mount()
  await click(tab(zh['tab.fleet']))
  await click(zh.fleetStart)
  expect(server.requests).toContainEqual({ path: 'fleet/sglang/start', method: 'POST' })
  expect(document.querySelectorAll('.dt-fleet-card')[1]?.getAttribute('data-status')).toBe('starting')
  expect(document.querySelector('.dt-toast')?.textContent).toBe('Started')
})

it('expands repository health, work, workspace and log details in place', async () => {
  server.fleet.deployments[1]!.health = [{ name: 'github', state: 'error', detail: 'bad token' }]
  server.fleet.deployments[1]!.log = { path: '/srv/logs/sglang.log', tail: 'last useful line' }
  await mount()
  await click(tab(zh['tab.fleet']))
  await click(all('.dt-fleet-details summary')[1]!)
  expect(document.querySelector('.dt-fleet-workspace')).not.toBeNull()
  expect(text()).toContain('bad token')
  expect(text()).toContain('last useful line')
  expect(text()).toContain('http://127.0.0.1:3083')
})

it('renders the fleet in English', async () => {
  await mount(en)
  await click(tab(en['tab.fleet']))
  expect(all('.dt-card-title').map(title => title.textContent)).toEqual(['onenexus-team/inference-support-loop',
    'onenexus-team/sglang'])
  expect(all('.dt-tag').map(tag => tag.textContent)).toEqual(['Ready', 'Stopped'])
})

it('switches every management view to the selected deployment and remembers the selection', async () => {
  await mount()
  const selector = field<HTMLSelectElement>(zh.deploymentContext)
  expect([...selector.options].map(option => [option.value, option.textContent])).toEqual([
    ['inference-support-loop', 'onenexus-team/inference-support-loop'],
    ['sglang', 'onenexus-team/sglang'],
  ])

  await type(selector, 'sglang')
  expect(sessionStorage.getItem('dsh-superagent/deployment')).toBe('sglang')
  expect(server.requests.some(request => request.path === 'deployment/sglang/state')).toBe(true)

  await click(tab(zh['tab.settings']))
  expect(server.requests.some(request => request.path === 'deployment/sglang/settings')).toBe(true)

  await remount()
  expect(field<HTMLSelectElement>(zh.deploymentContext).value).toBe('sglang')
})

it('migrates a stale desktop selection to the first registered deployment without privileging a repository', async () => {
  server.fleet.deployments.reverse()
  sessionStorage.setItem('dsh-superagent/deployment', 'desktop')
  await mount()
  expect(field<HTMLSelectElement>(zh.deploymentContext).value).toBe('sglang')
  expect(sessionStorage.getItem('dsh-superagent/deployment')).toBe('sglang')
  expect(server.requests.some(request => request.path === 'deployment/sglang/state')).toBe(true)
})

it('opens the selected deployment from its Fleet card', async () => {
  await mount()
  await click(tab(zh['tab.fleet']))
  await click(all('.dt-fleet-card')[1]!.querySelector('button:last-child')!)
  expect(tab(zh['tab.overview']).getAttribute('aria-selected')).toBe('true')
  expect(field<HTMLSelectElement>(zh.deploymentContext).value).toBe('sglang')
  expect(server.requests.some(request => request.path === 'deployment/sglang/state')).toBe(true)
})

it('keeps host-level machine limits read-only when a peer deployment is selected', async () => {
  await mount()
  await type(field<HTMLSelectElement>(zh.deploymentContext), 'sglang')
  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.deployment'], '.dt-settings-link'))
  expect(text()).toContain(zh.deploymentManagedProfile)
  expect(field<HTMLInputElement>(zh.deploymentPromptMaxChars).disabled).toBe(true)
})
