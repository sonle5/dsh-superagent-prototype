import { execFile, execFileSync } from 'node:child_process'
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

  const lifecycle = await run({
    operation: 'lifecycle', login: 'alice', id: 'widgets', action: 'restart',
    gatewayUser: 'gateway', gatewayGroup: 'gateway', checkout: '/opt/dsh-superagent', baseDir,
  })
  expect(lifecycle).toMatchObject({ code: 0 })
  expect(JSON.parse(lifecycle.stdout)).toEqual({
    id: 'widgets', action: 'restart', state: 'unchanged',
    unit: 'dsh-superagent-person-alice-widgets.service', output: '',
  })

  const status = await run({
    operation: 'status', login: 'alice', id: 'widgets',
    gatewayUser: 'gateway', gatewayGroup: 'gateway', checkout: '/opt/dsh-superagent', baseDir,
  })
  expect(status).toMatchObject({ code: 0 })
  expect(JSON.parse(status.stdout)).toEqual({
    id: 'widgets', state: 'unchanged', unit: 'dsh-superagent-person-alice-widgets.service',
  })

  const logs = await run({
    operation: 'logs', login: 'alice', id: 'widgets', lines: 80,
    gatewayUser: 'gateway', gatewayGroup: 'gateway', checkout: '/opt/dsh-superagent', baseDir,
  })
  expect(logs).toMatchObject({ code: 0 })
  expect(JSON.parse(logs.stdout)).toEqual({
    id: 'widgets', state: 'unchanged', unit: 'dsh-superagent-person-alice-widgets.service', tail: '',
  })
})

it('keeps the detached deployment alive when recovery finishes', () => {
  const unit = execFileSync('python3', ['-c', [
    'import runpy, sys',
    `module = runpy.run_path(${JSON.stringify(script)})`,
    "sys.stdout.write(module['recover_unit_content']('dsh-alice', '/opt/dsh-superagent', '/etc/example.env', "
      + "'superagent-widgets', 'http://127.0.0.1:3083', '/var/lib/widgets'))",
  ].join('\n')], { encoding: 'utf8' })
  expect(unit).toContain('KillMode=process')
})

it('allows stop and restart to outlive the launcher graceful-stop budget', () => {
  const timeouts = JSON.parse(execFileSync('python3', ['-c', [
    'import json, runpy, types',
    `module = runpy.run_path(${JSON.stringify(script)})`,
    'calls = []',
    "module['systemctl_state'] = lambda _unit: 'inactive'",
    'def run(command, **options):',
    '    if command[1] in ("start", "stop", "restart"):',
    '        calls.append((command[1], options["timeout"]))',
    "    return types.SimpleNamespace(returncode=0, stdout='', stderr='')",
    "module['subprocess'].run = run",
    "for action in ('start', 'stop', 'restart'):",
    "    module['systemctl_action']('alice', 'widgets', action, False)",
    'print(json.dumps(calls))',
  ].join('\n')], { encoding: 'utf8' })) as [string, number][]

  expect(timeouts).toEqual([['start', 300], ['stop', 340], ['restart', 340]])
})

it('repairs an existing person without rerunning useradd', () => {
  execFileSync('python3', ['-c', [
    'import runpy, tempfile, types',
    'from pathlib import Path',
    `module = runpy.run_path(${JSON.stringify(script)})`,
    'commands = []',
    "module['subprocess'].run = lambda *args, **kwargs: types.SimpleNamespace(returncode=0)",
    "module['run_checked'] = lambda command: commands.append(command)",
    "module['shutil'].chown = lambda *args, **kwargs: None",
    'modes = {}',
    "module['os'].chmod = lambda path, mode: modes.__setitem__(str(path), mode)",
    'with tempfile.TemporaryDirectory() as base:',
    "    result = module['create_person']('alice', Path(base), False)",
    '    assert commands == []',
    "    assert modes[result['home']] == 0o700",
    "    assert Path(result['home']).is_dir()",
  ].join('\n')])
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

  const invalidAction = await run({
    operation: 'lifecycle', login: 'alice', id: 'widgets', action: 'shell',
    gatewayUser: 'gateway', gatewayGroup: 'gateway', checkout: '/opt/dsh-superagent', baseDir: '/var/lib/dsh-superagent',
  })
  expect(invalidAction).toMatchObject({ code: 1, stderr: expect.stringContaining('action must be') })

  const invalidLines = await run({
    operation: 'logs', login: 'alice', id: 'widgets', lines: 81,
    gatewayUser: 'gateway', gatewayGroup: 'gateway', checkout: '/opt/dsh-superagent', baseDir: '/var/lib/dsh-superagent',
  })
  expect(invalidLines).toMatchObject({ code: 1, stderr: expect.stringContaining('lines must be between') })

  const longLogin = await run({
    operation: 'person', login: 'A'.repeat(39), gatewayUser: 'gateway', gatewayGroup: 'gateway',
    checkout: '/opt/dsh-superagent', baseDir: '/var/lib/dsh-superagent',
  })
  expect(longLogin).toMatchObject({ code: 0 })
  const user = JSON.parse(longLogin.stdout).user as string
  expect(user).toMatch(/^dsh-[a-z0-9-]{1,28}$/)
  expect(user.length).toBeLessThanOrEqual(32)
})
