/** Read-only aggregation and fixed-profile lifecycle control for independent Superagent deployments. */
import { spawn } from 'node:child_process'
import {
  accessSync, closeSync, constants, existsSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { nativeToken } from './native-auth.ts'

const profile = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, 'DSH profile name')
const absolute = z.string().refine(isAbsolute, 'Absolute path')
const loopback = z.string().refine(value => {
  let url: URL
  try { url = new URL(value) } catch { return false }
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.pathname === '/' && !url.search && !url.hash
}, 'Loopback HTTP URL')

const Managed = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase deployment id'),
  profile,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/repository'),
  url: loopback,
  stateDir: absolute,
  workspace: absolute,
})
const Selection = z.object({
  version: z.literal(1),
  deployment: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase deployment id'),
})
const Registry = z.object({
  version: z.literal(1),
  controlScript: absolute.optional(),
  logDir: absolute.optional(),
  deployments: z.array(Managed).default([]),
}).superRefine((value, context) => {
  if (value.deployments.length && !value.controlScript) {
    context.addIssue({ code: 'custom', path: ['controlScript'], message: 'Required when deployments are registered' })
  }
  if (value.deployments.length && !value.logDir) {
    context.addIssue({ code: 'custom', path: ['logDir'], message: 'Required when deployments are registered' })
  }
  for (const field of ['id', 'profile', 'url'] as const) {
    const seen = new Set<string>()
    for (const deployment of value.deployments) {
      if (seen.has(deployment[field])) context.addIssue({ code: 'custom', path: ['deployments', field],
        message: `Duplicate deployment ${field}: ${deployment[field]}` })
      seen.add(deployment[field])
    }
  }
})
type ManagedConfig = z.infer<typeof Managed>
type RegistryConfig = z.infer<typeof Registry>

const Health = z.object({ state: z.string(), detail: z.string().default('') }).passthrough()
const Problem = z.object({ code: z.string().optional(), detail: z.string().optional() }).passthrough()
const State = z.object({
  setup: z.object({
    problem: Problem.nullable().optional(),
    feishuProblem: Problem.nullable().optional(),
    accounts: z.object({ repository: z.string(), agent: z.string() }).passthrough().nullable().optional(),
  }).passthrough(),
  load: z.object({
    running: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    maxWorkers: z.number().int().nonnegative(),
  }).passthrough(),
  paused: z.boolean(),
  health: z.record(z.string(), Health).default({}),
}).passthrough()
const Ticket = z.object({
  id: z.string(),
  title: z.string(),
  stage: z.object({ stage: z.string() }).passthrough(),
  updatedAt: z.string(),
}).passthrough()
const Tickets = z.object({ items: z.array(Ticket) }).passthrough()
const Thread = z.object({
  key: z.string(),
  title: z.string(),
  source: z.string(),
  lastAt: z.string(),
  pending: z.number().int().nonnegative().default(0),
  evaluating: z.unknown().optional(),
})
const Threads = z.object({ items: z.array(Thread) }).passthrough()

export type FleetStatus = 'ready' | 'warning' | 'starting' | 'paused' | 'setup' | 'error' | 'stopped' | 'unreachable'
export interface FleetHealthView { name: string; state: string; detail: string }
export interface FleetTicketView { id: string; title: string; stage: string; updatedAt: string }
export interface FleetTriggerView { key: string; title: string; source: string; lastAt: string; pending: number; evaluating: boolean }
export interface FleetDeploymentView {
  id: string
  name: string
  repository: string
  profile: string
  url: string
  stateDir: string
  workspace: string
  status: FleetStatus
  detail: string
  health: FleetHealthView[]
  load: { running: number; queued: number; maxWorkers: number }
  tickets: { open: number; pending: number; working: number; idle: number; recent: FleetTicketView[] }
  triggers: { pending: number; evaluating: number; recent: FleetTriggerView[] }
  log?: { path: string; tail: string }
  canControl: boolean
}
export interface FleetView {
  configured: boolean
  selected?: string
  registryPath: string
  error?: string
  updatedAt: string
  deployments: FleetDeploymentView[]
}

/** One authenticated loopback peer available to the controller's native transport. */
export interface FleetNativeTarget {
  id: string
  url: string
  repository: string
  profile: string
  stateDir: string
  workspace: string
  token: string
}

/** A lifecycle refusal with the HTTP status the management route should return. */
export class FleetControlError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message) }
}

type DeploymentConfig = ManagedConfig

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const emptyTickets = z.object({ items: z.array(Ticket).default([]) })
const emptyThreads = z.object({ items: z.array(Thread).default([]) })
/** Remove credentials that a child deployment or log line may echo. */
export const redactSensitive = (text: string): string => text
  .replace(/([?&](?:token|access_token|api[_-]?key|key)=)[^&\s]+/gi, '$1[redacted]')
  .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|onenx_[A-Za-z0-9_-]{12,})\b/g, '[redacted]')
  .replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1[redacted]')
  .replace(/((?:api[_-]?key|token)\s*[:=]\s*)["']?[^"'\s]+/gi, '$1[redacted]')
const title = (deployment: DeploymentConfig, repository = deployment.repository): string => repository || deployment.repository

function loadRegistry(path: string): { value?: RegistryConfig; configured: boolean; error?: string } {
  if (!existsSync(path)) return { configured: false }
  try {
    const parsed = Registry.safeParse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
    return parsed.success ? { value: parsed.data, configured: true } : { configured: true, error: `Invalid fleet registry: ${reason(parsed.error)}` }
  } catch (error) {
    return { configured: true, error: `Could not read fleet registry: ${reason(error)}` }
  }
}

function executable(path: string | undefined): boolean {
  if (!path) return false
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}

function api(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/orchestrator/api/${path}`
}

async function json<T extends z.ZodType>(url: string, schema: T): Promise<z.infer<T>> {
  const response = await fetch(url, {
    headers: { 'x-orchestrator-request': '1', accept: 'application/json' },
    signal: AbortSignal.timeout(2_500),
  })
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).pathname}`)
  return schema.parse(await response.json() as unknown)
}

function logTail(logDir: string | undefined, profile: string): { path: string; tail: string } | undefined {
  if (!logDir || !existsSync(logDir)) return undefined
  try {
    const prefix = `dsh-superagent-${profile}-`
    const files = readdirSync(logDir).filter(name => name.startsWith(prefix) && name.endsWith('.log'))
      .map(name => join(logDir, name)).sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    const path = files[0]
    if (!path) return undefined
    const size = statSync(path).size
    const length = Math.min(size, 64 * 1024)
    const buffer = Buffer.alloc(length)
    const descriptor = openSync(path, 'r')
    try { readSync(descriptor, buffer, 0, length, size - length) } finally { closeSync(descriptor) }
    const lines = buffer.toString('utf8').split('\n')
    if (size > length) lines.shift()
    return { path, tail: redactSensitive(lines.slice(-80).join('\n')) }
  } catch { return undefined }
}

function statusOf(state: z.infer<typeof State>): { status: FleetStatus; detail: string } {
  const problems = [
    state.setup.problem?.detail,
    state.setup.feishuProblem?.detail,
    ...Object.values(state.health).filter(item => item.state === 'error').map(item => item.detail),
  ].filter((value): value is string => !!value).map(redactSensitive)
  if (state.setup.problem) return { status: 'setup', detail: problems[0] ?? 'Waiting for setup' }
  const runtime = state.health.runtime?.state
  if (runtime === 'error') return { status: 'error', detail: problems[0] ?? 'Runtime is failing' }
  if (runtime === 'starting') return { status: 'starting', detail: 'Starting' }
  if (state.paused || runtime === 'paused') return { status: 'paused', detail: problems[0] ?? 'Processing is paused' }
  if (problems.length) return { status: 'warning', detail: problems[0]! }
  return { status: 'ready', detail: 'Ready' }
}

function stopped(logDir: string | undefined, profile: string): boolean {
  return !!logDir && existsSync(join(logDir, 'control', 'profiles', profile, 'manually-stopped'))
}

async function snapshot(deployment: DeploymentConfig, logDir: string | undefined, canControl: boolean): Promise<FleetDeploymentView> {
  try {
    const state = await json(api(deployment.url, 'state'), State)
    const [tickets, threads] = await Promise.all([
      json(api(deployment.url, 'tickets?state=open&limit=1000'), Tickets).catch(() => emptyTickets.parse({})),
      json(api(deployment.url, 'threads?filter=recent&limit=20'), Threads).catch(() => emptyThreads.parse({})),
    ])
    const status = statusOf(state)
    const stage = (value: string) => tickets.items.filter(ticket => ticket.stage.stage === value).length
    const repository = state.setup.accounts?.repository || deployment.repository
    return {
      ...deployment,
      name: title(deployment, repository),
      repository,
      ...status,
      health: Object.entries(state.health).map(([name, item]) => ({ name, state: item.state, detail: redactSensitive(item.detail) })),
      load: state.load,
      tickets: {
        open: tickets.items.length,
        pending: stage('person'),
        working: stage('working'),
        idle: stage('idle'),
        recent: tickets.items.slice(0, 8).map(ticket => ({ id: ticket.id, title: ticket.title, stage: ticket.stage.stage,
          updatedAt: ticket.updatedAt })),
      },
      triggers: {
        pending: threads.items.reduce((sum, thread) => sum + thread.pending, 0),
        evaluating: threads.items.filter(thread => thread.evaluating !== undefined && thread.evaluating !== null).length,
        recent: threads.items.slice(0, 8).map(thread => ({ key: thread.key, title: thread.title, source: thread.source, lastAt: thread.lastAt,
          pending: thread.pending, evaluating: thread.evaluating !== undefined && thread.evaluating !== null })),
      },
      log: logTail(logDir, deployment.profile),
      canControl,
    }
  } catch (error) {
    return {
      ...deployment,
      name: title(deployment),
      status: stopped(logDir, deployment.profile) ? 'stopped' : 'unreachable',
      detail: stopped(logDir, deployment.profile) ? 'Stopped intentionally' : redactSensitive(reason(error)),
      health: [],
      load: { running: 0, queued: 0, maxWorkers: 0 },
      tickets: { open: 0, pending: 0, working: 0, idle: 0, recent: [] },
      triggers: { pending: 0, evaluating: 0, recent: [] },
      log: logTail(logDir, deployment.profile),
      canControl,
    }
  }
}

export type FleetAction = 'start' | 'stop' | 'restart'

/** Aggregate repository-bound deployments and control only profiles present in the local registry. */
export class Fleet {
  readonly registryPath: string
  private readonly selectionPath: string
  private readonly busy = new Set<string>()
  constructor(readonly stateDir: string) {
    this.registryPath = join(stateDir, 'fleet.json')
    this.selectionPath = join(stateDir, 'native-deployment.json')
  }

  async view(): Promise<FleetView> {
    const loaded = loadRegistry(this.registryPath)
    const control = loaded.value?.controlScript
    const logDir = loaded.value?.logDir
    const deployments = await Promise.all((loaded.value?.deployments ?? []).map(deployment =>
      snapshot(deployment, logDir, executable(control))))
    const selected = this.selectedId()
    return {
      configured: loaded.configured,
      ...selected !== undefined && deployments.some(deployment => deployment.id === selected)
        ? { selected }
        : {},
      registryPath: this.registryPath,
      ...loaded.error ? { error: loaded.error } : {},
      updatedAt: new Date().toISOString(),
      deployments,
    }
  }

  async control(id: string, action: FleetAction): Promise<{ id: string; action: FleetAction; code: number; output: string }> {
    const loaded = loadRegistry(this.registryPath)
    if (loaded.error) throw new FleetControlError(400, loaded.error)
    const deployment = loaded.value?.deployments.find(item => item.id === id)
    if (!deployment) throw new FleetControlError(404, `Deployment not found: ${id}`)
    const script = loaded.value?.controlScript
    if (!executable(script) || !script) throw new FleetControlError(400, 'The configured fleet control script is not executable')
    if (this.busy.has(id)) throw new FleetControlError(409, `Another lifecycle action is already running for ${id}`)
    this.busy.add(id)
    try {
      const args = [action, '--profile', deployment.profile, '--url', deployment.url]
      if (action !== 'start') args.push('--stop-timeout', '60')
      const result = await run(script, args)
      if (![0, 2, 3].includes(result.code)) throw new FleetControlError(400, result.output || `${action} failed`)
      return { id, action, ...result, output: redactSensitive(result.output) }
    } finally { this.busy.delete(id) }
  }

  /** Resolve a deployment only from the validated registry. */
  managementTarget(id: string): Omit<FleetNativeTarget, 'token'> {
    const loaded = loadRegistry(this.registryPath)
    if (loaded.error) throw new FleetControlError(400, loaded.error)
    const deployment = loaded.value?.deployments.find(item => item.id === id)
    if (!deployment) throw new FleetControlError(404, `Deployment not found: ${id}`)
    return {
      id: deployment.id,
      url: deployment.url,
      repository: deployment.repository,
      profile: deployment.profile,
      stateDir: deployment.stateDir,
      workspace: deployment.workspace,
    }
  }

  /** Select the deployment whose native DSH state and streams the Desktop controller serves. */
  select(id: string): { selected: string } {
    this.managementTarget(id)
    const temporary = `${this.selectionPath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, deployment: id })}\n`, { mode: 0o600 })
    renameSync(temporary, this.selectionPath)
    return { selected: id }
  }

  /** Resolve the selected deployment, or undefined before the first selection. */
  nativeTarget(): FleetNativeTarget | undefined {
    const id = this.selectedId()
    if (id === undefined) return undefined
    const target = this.managementTarget(id)
    return { ...target, token: nativeToken(target.stateDir)! }
  }

  /** Resolve every validated deployment as an independently authenticated native peer. */
  nativeTargets(): FleetNativeTarget[] {
    const loaded = loadRegistry(this.registryPath)
    if (loaded.error) throw new FleetControlError(400, loaded.error)
    return (loaded.value?.deployments ?? []).map(deployment => ({
      id: deployment.id,
      url: deployment.url,
      repository: deployment.repository,
      profile: deployment.profile,
      stateDir: deployment.stateDir,
      workspace: deployment.workspace,
      token: nativeToken(deployment.stateDir)!,
    }))
  }

  private selectedId(): string | undefined {
    if (!existsSync(this.selectionPath)) return undefined
    try {
      return Selection.parse(JSON.parse(readFileSync(this.selectionPath, 'utf8')) as unknown).deployment
    } catch (error) {
      throw new FleetControlError(400, `Invalid native deployment selection: ${reason(error)}`)
    }
  }
}

function run(script: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(script, args, { env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let timedOut = false
    const collect = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-64 * 1024) }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 180_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) reject(new FleetControlError(400, 'Lifecycle action timed out'))
      else resolve({ code: code ?? (signal ? 1 : 0), output: output.trim() })
    })
  })
}
