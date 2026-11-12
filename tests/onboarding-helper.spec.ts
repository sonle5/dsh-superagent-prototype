import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const script = join(import.meta.dirname, '..', 'scripts', 'dsh-superagent-onboard')

function run(request: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile(script, ['--dry-run'], { timeout: 10_000 })
    child.stdin?.end(JSON.stringify(request))
    let stdout = '', stderr = ''
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.once('error', error => resolve({ code: 1, stdout, stderr: String(error) }))
    child.once('close', code => resolve({ code: code ?? 0, stdout, stderr }))
  })
}

it('plans a person and deployment with derived server paths', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'dsh-onboard-plan-'))
  const person = await run({
    operation: 'person', login: 'alice', gatewayUser: 'gateway', gatewayGroup: 'gateway',
    checkout: '/opt/dsh-superagent', baseDir,
  })
  expect(person).toMatchObject({ code: 0 })
  expect(JSON.parse(person.stdout)).toEqual({
    user: 'dsh-alice', home: `${baseDir}/people/alice`, dshHome: `${baseDir}/people/alice/dsh-home`,
  })

  const deployment = await run({
    operation: 'deployment', login: 'alice', id: 'widgets', repository: 'example-org/widgets',
    gatewayUser: 'gateway', gatewayGroup: 'gateway', checkout: '/opt/dsh-superagent', baseDir,
    usedPorts: ['http://127.0.0.1:3082'],
  })
  expect(deployment).toMatchObject({ code: 0 })
  expect(JSON.parse(deployment.stdout)).toMatchObject({
    id: 'widgets', profile: 'superagent-widgets', repository: 'example-org/widgets',
    profileTemplate: 'web',
    url: 'http://127.0.0.1:3083',
    stateDir: `${baseDir}/people/alice/deployments/widgets`,
    workspace: `${baseDir}/people/alice/worktrees/widgets`,
    tokenDir: `${baseDir}/gateway/tokens/widgets`,
    healthUnit: '/etc/systemd/system/dsh-superagent-person-alice-widgets-health.service',
    recoverUnit: '/etc/systemd/system/dsh-superagent-person-alice-widgets-recover.service',
    healthTimer: '/etc/systemd/system/dsh-superagent-person-alice-widgets-health.timer',
  })

  const credentials = await run({
    operation: 'credentials', login: 'alice', id: 'widgets', githubToken: 'agent-github-token-1234',
    gatewayUser: 'gateway', gatewayGroup: 'gateway', checkout: '/opt/dsh-superagent', baseDir,
  })
  expect(credentials).toMatchObject({ code: 0 })
  expect(JSON.parse(credentials.stdout)).toEqual({
    id: 'widgets', cli: `${baseDir}/people/alice/bin/agent-widgets`,
  })
})

it('rejects invalid names instead of deriving unsafe paths', async () => {
  const invalid = await run({
    operation: 'deployment', login: 'alice;rm', id: 'widgets', repository: 'example-org/widgets',
    gatewayUser: 'gateway', gatewayGroup: 'gateway', checkout: '/opt/dsh-superagent', baseDir: '/var/lib/dsh-superagent',
  })
  expect(invalid).toMatchObject({ code: 1, stderr: expect.stringContaining('invalid login') })

  const invalidToken = await run({
    operation: 'credentials', login: 'alice', id: 'widgets', githubToken: 'short-token',
    gatewayUser: 'gateway', gatewayGroup: 'gateway', checkout: '/opt/dsh-superagent', baseDir: '/var/lib/dsh-superagent',
  })
  expect(invalidToken).toMatchObject({ code: 1, stderr: expect.stringContaining('invalid GitHub token') })

  const longLogin = await run({
    operation: 'person', login: 'A'.repeat(39), gatewayUser: 'gateway', gatewayGroup: 'gateway',
    checkout: '/opt/dsh-superagent', baseDir: '/var/lib/dsh-superagent',
  })
  expect(longLogin).toMatchObject({ code: 0 })
  const user = JSON.parse(longLogin.stdout).user as string
  expect(user).toMatch(/^dsh-[a-z0-9-]{1,28}$/)
  expect(user.length).toBeLessThanOrEqual(32)
})
