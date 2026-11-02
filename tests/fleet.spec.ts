import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Fleet, FleetControlError } from '../src/app/fleet.ts'

const servers: Server[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function listen(repository: string): Promise<string> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const body = path.endsWith('/state') ? {
      setup: { problem: null, feishuProblem: null, accounts: { repository, agent: 'agent-bot' } },
      load: { running: 1, queued: 2, maxWorkers: 3 }, paused: false,
      health: { runtime: { state: 'ready', detail: 'Orchestrator is ready' } },
    } : path.endsWith('/tickets') ? { items: [
      { id: 't1', title: 'Fix replay', stage: { stage: 'working' }, updatedAt: '2026-11-02T00:00:00Z' },
      { id: 't2', title: 'Answer review', stage: { stage: 'person' }, updatedAt: '2026-11-02T00:01:00Z' },
    ] } : { items: [
      { key: 'github:32', title: 'PR 32', source: 'github', lastAt: '2026-11-02T00:02:00Z', pending: 4,
        evaluating: { id: 'e1' } },
    ] }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-fleet-'))
  directories.push(directory)
  return directory
}

it('aggregates independent deployments and their Tickets, Triggers, health, workspace and log tail', async () => {
  const state = workspace()
  const inference = await listen('onenexus-team/inference-support-loop')
  const sglang = await listen('onenexus-team/sglang')
  const logDir = join(state, '.artifacts')
  mkdirSync(logDir)
  writeFileSync(join(logDir, 'dsh-superagent-superagent-sglang-20261102-000000-1.log'),
    'first\nhttp://127.0.0.1:3083/?token=private-token\nAuthorization: Bearer private-bearer\n')
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1, controlScript: '/usr/bin/true', logDir,
    deployments: [{
      id: 'inference-support-loop', profile: 'superagent-inference-support-loop', repository: 'onenexus-team/inference-support-loop',
      url: inference, stateDir: join(state, 'superagent'), workspace: '/Users/alice/src/inference-support-loop',
    }, {
      id: 'sglang', profile: 'superagent-sglang', repository: 'onenexus-team/sglang', url: sglang,
      stateDir: join(state, 'superagent-sglang'), workspace: '/Users/alice/src/sglang-superagent',
    }],
  }))

  const view = await new Fleet(state).view()
  expect(view).toMatchObject({ configured: true, deployments: [
    { id: 'inference-support-loop', name: 'onenexus-team/inference-support-loop',
      repository: 'onenexus-team/inference-support-loop', status: 'ready', canControl: true,
      load: { running: 1, queued: 2, maxWorkers: 3 } },
    { id: 'sglang', name: 'onenexus-team/sglang', repository: 'onenexus-team/sglang', status: 'ready', canControl: true,
      tickets: { open: 2, pending: 1, working: 1, idle: 0 },
      triggers: { pending: 4, evaluating: 1 } },
  ] })
  expect(view.deployments[1]?.log?.tail).toContain('http://127.0.0.1:3083/?token=[redacted]')
  expect(view.deployments[1]?.log?.tail).toContain('Authorization: Bearer [redacted]')
  expect(view.deployments[1]?.log?.tail).not.toContain('private-token')
  expect(view.deployments[1]?.log?.tail).not.toContain('private-bearer')
})

it('distinguishes an intentionally stopped deployment from an unreachable one', async () => {
  const state = workspace()
  const logDir = join(state, '.artifacts')
  mkdirSync(join(logDir, 'control', 'profiles', 'superagent-sglang'), { recursive: true })
  writeFileSync(join(logDir, 'control', 'profiles', 'superagent-sglang', 'manually-stopped'), '2026-11-02T00:00:00Z\n')
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1, controlScript: '/usr/bin/true', logDir,
    deployments: [{ id: 'sglang', name: 'SGLang', profile: 'superagent-sglang', repository: 'onenexus-team/sglang',
      url: 'http://127.0.0.1:9', stateDir: join(state, 'superagent-sglang'), workspace: '/Users/alice/src/sglang-superagent' }],
  }))
  expect((await new Fleet(state).view()).deployments[0]).toMatchObject({ status: 'stopped', detail: 'Stopped intentionally' })
})

it('reports an invalid registry without inventing a deployment', async () => {
  const state = workspace()
  writeFileSync(join(state, 'fleet.json'), '{"version":1,"deployments":[{"id":"../escape"}]}')
  const view = await new Fleet(state).view()
  expect(view).toMatchObject({ configured: true, error: expect.stringContaining('Invalid fleet registry') })
  expect(view.deployments).toEqual([])
})

it('invokes only the configured fixed script for a registered profile', async () => {
  const state = workspace()
  const argumentsFile = join(state, 'args')
  const script = join(state, 'control')
  writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argumentsFile)}\n`)
  chmodSync(script, 0o755)
  writeFileSync(join(state, 'fleet.json'), JSON.stringify({
    version: 1, controlScript: script, logDir: join(state, '.artifacts'),
    deployments: [{ id: 'sglang', name: 'SGLang', profile: 'superagent-sglang', repository: 'onenexus-team/sglang',
      url: 'http://127.0.0.1:3083', stateDir: join(state, 'superagent-sglang'), workspace: '/Users/alice/src/sglang-superagent' }],
  }))
  const fleet = new Fleet(state)
  expect(await fleet.control('sglang', 'restart')).toMatchObject({ id: 'sglang', action: 'restart', code: 0 })
  expect(readFileSync(argumentsFile, 'utf8'))
    .toBe('restart\n--profile\nsuperagent-sglang\n--url\nhttp://127.0.0.1:3083\n--stop-timeout\n60\n')
  await expect(fleet.control('missing', 'start')).rejects.toEqual(expect.objectContaining<Partial<FleetControlError>>({
    status: 404, message: 'Deployment not found: missing',
  }))
})
