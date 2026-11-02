// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { all, click, mount, tab, text, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

it('shows every deployment in the native fleet page and controls only registered managed profiles', async () => {
  await mount()
  await click(tab(zh['tab.fleet']))
  expect(tab(zh['tab.fleet']).getAttribute('aria-selected')).toBe('true')
  expect(all('.dt-fleet-card').map(card => card.getAttribute('data-status'))).toEqual(['ready', 'stopped'])
  expect(text()).toContain('acme/widgets')
  expect(text()).toContain('onenexus-team/sglang')
  expect(text()).toContain('/Users/alice/src/sglang-superagent')
  expect(all('.dt-fleet-card')[0]!.querySelectorAll('button')).toHaveLength(0)
  expect([...all('.dt-fleet-card')[1]!.querySelectorAll('button')].map(button => button.textContent)).toEqual([zh.fleetStart])
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
  expect(text()).toContain('bad token')
  expect(text()).toContain('last useful line')
  expect(text()).toContain('http://127.0.0.1:3083')
})

it('renders the fleet in English', async () => {
  await mount(en)
  await click(tab(en['tab.fleet']))
  expect(all('.dt-card-title').map(title => title.textContent)).toEqual(['acme/widgets', 'onenexus-team/sglang'])
  expect(all('.dt-tag').map(tag => tag.textContent)).toEqual(['Ready', 'Stopped'])
})
