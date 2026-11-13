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

it('plans a protected model proxy on a dedicated Linux identity', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'dsh-model-proxy-plan-'))
  const result = await run({
    operation: 'model-proxy', action: 'ensure', login: 'alice',
    gatewayUser: 'gateway', gatewayGroup: 'gateway', checkout: '/opt/dsh-superagent', baseDir,
    modelProxy: { binary: '/opt/cliproxyapi/cli-proxy-api', portRange: { start: 8317, end: 9316 } },
  })
  expect(result).toMatchObject({ code: 0 })
  const plan = JSON.parse(result.stdout) as Record<string, unknown>
  expect(plan).toMatchObject({
    user: 'dsh-alice-models',
    stateDir: `${baseDir}/model-proxies/alice`,
    legacyStateDir: `${baseDir}/people/alice/model-proxy`,
    config: `${baseDir}/model-proxies/alice/config.yaml`,
    authDir: `${baseDir}/model-proxies/alice/auth`,
    managementSecret: `${baseDir}/model-proxies/alice/management-secret`,
    unit: 'dsh-superagent-person-alice-model-proxy.service',
  })
  expect(plan.unitContent).toContain('User=dsh-alice-models')
  expect(plan.unitContent).toContain('ProtectHome=yes')
  expect(plan.unitContent).toContain('ProtectSystem=strict')
  expect(plan.unitContent).toContain(`ReadWritePaths=${baseDir}/model-proxies/alice`)
})

it('derives a short model-proxy user for long GitHub logins', async () => {
  const result = await run({
    operation: 'model-proxy', action: 'ensure', login: 'A'.repeat(39),
    gatewayUser: 'gateway', gatewayGroup: 'gateway', checkout: '/opt/dsh-superagent',
    baseDir: '/var/lib/dsh-superagent',
    modelProxy: { binary: '/opt/cliproxyapi/cli-proxy-api', portRange: { start: 8317, end: 9316 } },
  })
  expect(result).toMatchObject({ code: 0 })
  const user = JSON.parse(result.stdout).user as string
  expect(user).toMatch(/^dsh-m-[a-f0-9]{16}$/)
  expect(user.length).toBeLessThanOrEqual(32)
})

it('rejects unbounded model-proxy configuration', async () => {
  const missing = await run({
    operation: 'model-proxy', action: 'ensure', login: 'alice',
    gatewayUser: 'gateway', gatewayGroup: 'gateway', checkout: '/opt/dsh-superagent',
    baseDir: '/var/lib/dsh-superagent',
  })
  expect(missing).toMatchObject({ code: 1, stderr: expect.stringContaining('modelProxy configuration is required') })

  const invalid = await run({
    operation: 'model-proxy', action: 'status', login: 'alice',
    gatewayUser: 'gateway', gatewayGroup: 'gateway', checkout: '/opt/dsh-superagent',
    baseDir: '/var/lib/dsh-superagent',
    modelProxy: { binary: 'relative', portRange: { start: 80, end: 90 } },
  })
  expect(invalid).toMatchObject({ code: 1, stderr: expect.stringContaining('absolute path') })
})

it('allocates stable, distinct proxy ports for multiple protected people', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'dsh-model-proxy-ports-'))
  const modelProxy = { binary: '/opt/cliproxyapi/cli-proxy-api', portRange: { start: 8317, end: 8416 } }
  const plan = async (login: string): Promise<number> => {
    const result = await run({
      operation: 'model-proxy', action: 'ensure', login,
      gatewayUser: 'gateway', gatewayGroup: 'gateway', checkout: '/opt/dsh-superagent', baseDir, modelProxy,
    })
    expect(result).toMatchObject({ code: 0 })
    const port = JSON.parse(result.stdout).port as number
    expect(port).toBeGreaterThanOrEqual(8317)
    expect(port).toBeLessThanOrEqual(8416)
    return port
  }
  const alice = await plan('alice')
  const bob = await plan('bob')
  expect(alice).not.toBe(bob)
  expect(await plan('alice')).toBe(alice)
})

it('reuses an assigned port and skips ports already owned by another protected person', () => {
  const ports = JSON.parse(execFileSync('python3', ['-c', [
    'import json, runpy, tempfile',
    'from pathlib import Path',
    'import yaml',
    `module = runpy.run_path(${JSON.stringify(script)})`,
    "module['port_is_available'] = lambda _port: True",
    'with tempfile.TemporaryDirectory() as base:',
    '    root = Path(base) / "model-proxies"',
    '    alice = root / "alice"',
    '    bob = root / "bob"',
    '    alice.mkdir(parents=True)',
    '    bob.mkdir(parents=True)',
    '    first = module["allocate_model_proxy_port"]("alice", alice, 8317, 8416)',
    '    (alice / "config.yaml").write_text(yaml.safe_dump({"port": first}))',
    '    reused = module["allocate_model_proxy_port"]("alice", alice, 8317, 8416)',
    '    second = module["allocate_model_proxy_port"]("bob", bob, 8317, 8416)',
    '    print(json.dumps({"first": first, "reused": reused, "second": second}))',
  ].join('\n')], { encoding: 'utf8' })) as { first: number; reused: number; second: number }
  expect(ports.reused).toBe(ports.first)
  expect(ports.second).not.toBe(ports.first)
})

it('reads protected proxy ports from legacy and v8 config layouts', () => {
  const ports = JSON.parse(execFileSync('python3', ['-c', [
    'import json, runpy, tempfile',
    'from pathlib import Path',
    'import yaml',
    `module = runpy.run_path(${JSON.stringify(script)})`,
    'with tempfile.TemporaryDirectory() as base:',
    '    state = Path(base)',
    '    (state / "config.yaml").write_text(yaml.safe_dump({"port": 8401}))',
    '    legacy = module["configured_model_proxy_port"](state)',
    '    (state / "config.yaml").write_text(yaml.safe_dump({"server": {"port": 8402}}))',
    '    v8 = module["configured_model_proxy_port"](state)',
    '    (state / "config.yaml").write_text(yaml.safe_dump({"server": {"port": True}, "port": 8403}))',
    '    legacy_fallback = module["configured_model_proxy_port"](state)',
    '    (state / "config.yaml").write_text(yaml.safe_dump({"server": {}}))',
    '    missing = module["configured_model_proxy_port"](state)',
    '    print(json.dumps({"legacy": legacy, "v8": v8, "legacyFallback": legacy_fallback, "missing": missing}))',
  ].join('\n')], { encoding: 'utf8' })) as {
    legacy: number
    v8: number
    legacyFallback: number
    missing: null
  }
  expect(ports).toEqual({ legacy: 8401, v8: 8402, legacyFallback: 8403, missing: null })
})

it('reports a controlled error when protected proxy management has no port', () => {
  const result = JSON.parse(execFileSync('python3', ['-c', [
    'import json, runpy, tempfile',
    'from pathlib import Path',
    'import yaml',
    `module = runpy.run_path(${JSON.stringify(script)})`,
    'with tempfile.TemporaryDirectory() as base:',
    '    state = Path(base)',
    '    (state / "config.yaml").write_text(yaml.safe_dump({"server": {}}))',
    '    (state / "management-secret").write_text("management-secret")',
    '    try:',
    '        module["management_request"](state, "GET", "/config/access/api-keys")',
    '    except Exception as error:',
    '        print(json.dumps({"type": type(error).__name__, "message": str(error)}))',
  ].join('\n')], { encoding: 'utf8' }))
  expect(result).toEqual({
    type: 'OnboardingError',
    message: 'model proxy config has no valid port',
  })
})

it('adds supported OpenAI replay models without dropping existing provider models', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'dsh-model-proxy-providers-'))
  const state = join(baseDir, 'model-proxies', 'alice')
  execFileSync('mkdir', ['-p', state])
  execFileSync('python3', ['-c', [
    'import yaml',
    'from pathlib import Path',
    `state = Path(${JSON.stringify(state)})`,
    '(state / "config.yaml").write_text(yaml.safe_dump({"server": {"port": 8401}}))',
    '(state / "management-secret").write_text("management-secret")',
  ].join('\n')])

  const result = execFileSync('python3', ['-c', [
    'import json, runpy, types',
    `module = runpy.run_path(${JSON.stringify(script)})`,
    'requests = []',
    'def request(_state, method, suffix, body=None, secret=None):',
    '    if method == "GET":',
    '        return [{"name": "openai", "base-url": "https://api.openai.com/v1", "keys": [{"api-key": "old"}], '
      + '"models": [{"name": "custom-model", "alias": "custom-model"}]}]',
    '    requests.append(body)',
    '    return None',
    "module['provider_key_set'].__globals__['management_request'] = request",
    'value = module["provider_key_set"]({',
    '    "login": "alice", "provider": "openai", "apiKey": "replacement-key",',
    `    "gatewayUser": "gateway", "gatewayGroup": "gateway", "checkout": "/opt/dsh-superagent", "baseDir": ${JSON.stringify(baseDir)},`,
    '    "modelProxy": {"binary": "/opt/cliproxyapi/cli-proxy-api", "portRange": {"start": 8317, "end": 9316}},',
    '}, False)',
    'print(json.dumps({"result": value, "models": [item["name"] for item in requests[0][0]["models"]]}))',
  ].join('\n')], { encoding: 'utf8' })

  expect(JSON.parse(result)).toEqual({
    result: { provider: 'openai', configured: true },
    models: ['custom-model', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-5.6-sol'],
  })
})
