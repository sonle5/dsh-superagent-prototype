/** Read-only aggregation and fixed-profile lifecycle control for independent Superagent deployments. */
import { spawn } from 'node:child_process'
import { createServer, type Server, type ServerResponse } from 'node:http'
import {
  accessSync, closeSync, constants, existsSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import type { AddressInfo } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { nativeToken } from './native-auth.ts'
import type { ModelProxyView } from './api.ts'

const profile = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, 'DSH profile name')
const absolute = z.string().refine(isAbsolute, 'Absolute path')
const loopback = z.string().refine(value => {
  let url: URL
  try { url = new URL(value) } catch { return false }
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.pathname === '/' && !url.search && !url.hash
}, 'Loopback HTTP URL')
const gatewayAddress = z.string().url().refine(value => {
  let url: URL
  try { url = new URL(value) } catch { return false }
  return (url.protocol === 'https:' || url.protocol === 'http:')
    && !url.search && !url.hash
}, 'HTTP(S) URL without a query or fragment')

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
const GatewaySessionFile = z.object({
  version: z.literal(1),
  url: gatewayAddress,
  token: z.string().min(1).optional(),
})
type GatewaySessionFileConfig = z.infer<typeof GatewaySessionFile>
type AuthenticatedGatewaySession = { url: string; token: string }
const GatewayFleet = z.object({
  organization: z.string().min(1),
  login: z.string().min(1),
  // Older gateways predate the account-readiness flag. Treat an omitted flag as not-yet-created so
  // a Desktop upgrade can still read the fleet during a rolling gateway deployment.
  person: z.boolean().default(false),
  deployments: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase deployment id'),
    profile,
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/repository'),
    capabilities: z.array(z.enum(['lifecycle', 'logs'])).default([]),
  })),
})
const GatewayDevice = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().default(5),
})
const GatewaySession = z.object({
  login: z.string().min(1),
  organization: z.string().min(1),
  expiresAt: z.string().min(1),
  nativeToken: z.string().min(1),
})
const GatewayPerson = z.object({
  login: z.string().min(1),
  user: z.string().min(1).optional(),
  created: z.boolean(),
})
const GatewayDeployment = z.object({
  login: z.string().min(1),
  created: z.boolean(),
  deployment: z.object({
    id: z.string().min(1),
    profile: z.string().min(1),
    repository: z.string().min(1),
    url: z.string().url(),
    stateDir: z.string().min(1),
    workspace: z.string().min(1),
  }),
})
const GatewayCredentials = z.object({
  saved: z.boolean(),
  revision: z.number().int().nonnegative(),
  restarting: z.boolean(),
})
const RemoteLifecycle = z.object({
  id: z.string().min(1),
  action: z.enum(['start', 'stop', 'restart']),
  state: z.string().min(1),
  output: z.string().default(''),
})
const RemoteStatus = z.object({
  id: z.string().min(1),
  state: z.string().min(1),
})
const RemoteLogs = z.object({
  id: z.string().min(1),
  state: z.string().min(1),
  tail: z.string(),
})
const ModelProxy = z.object({
  status: z.string().min(1),
  baseURL: z.string().url().refine(value => {
    const url = new URL(value)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && url.pathname === '/v1' && !url.search && !url.hash
  }, 'Loopback model proxy URL'),
  providers: z.array(z.object({
    id: z.enum(['claude', 'nexus13', 'one-nexus', 'openai']),
    label: z.string().min(1),
    state: z.enum(['connected', 'configured', 'sign-in-required', 'missing', 'error']),
  })),
  deployments: z.array(z.object({
    id: z.string().min(1),
    keyConfigured: z.boolean(),
  })),
})
const ClaudeConnect = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
})
const ClaudeStatus = z.object({
  state: z.enum(['idle', 'waiting', 'connected', 'error']),
  error: z.string().optional(),
})
const ModelProxyKey = z.object({
  id: z.string().min(1),
  value: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
})

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
  remote: boolean
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
  gateway?: {
    url: string
    organization?: string
    login?: string
    person?: boolean
    error?: string
  }
  error?: string
  updatedAt: string
  deployments: FleetDeploymentView[]
}

/** One authenticated management and native peer available to the controller's native transport. */
export interface FleetNativeTarget {
  id: string
  /** Whether management routes append to a gateway path instead of the deployment's loopback origin. */
  remote: boolean
  /** Management API base. A gateway deployment includes its path prefix. */
  url: string
  /** Native transport base. A gateway deployment includes its path prefix. */
  nativeUrl: string
  repository: string
  profile: string
  stateDir: string
  workspace: string
  token: string
}

interface RemoteDeployment {
  id: string
  profile: string
  repository: string
  capabilities: ('lifecycle' | 'logs')[]
}

/** A lifecycle refusal with the HTTP status the management route should return. */
export class FleetControlError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502, message: string) { super(message) }
}

/** A gateway HTTP refusal preserved while the controller translates it into a Fleet control error. */
class JsonRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
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
const title = (deployment: Pick<DeploymentConfig, 'repository'>, repository = deployment.repository): string => repository || deployment.repository

function loadRegistry(path: string): { value?: RegistryConfig; configured: boolean; error?: string } {
  if (!existsSync(path)) return { configured: false }
  try {
    const parsed = Registry.safeParse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
    return parsed.success ? { value: parsed.data, configured: true } : { configured: true, error: `Invalid fleet registry: ${reason(parsed.error)}` }
  } catch (error) {
    return { configured: true, error: `Could not read fleet registry: ${reason(error)}` }
  }
}

function loadGatewaySession(path: string): { value?: GatewaySessionFileConfig; configured: boolean; error?: string } {
  if (!existsSync(path)) return { configured: false }
  try {
    const parsed = GatewaySessionFile.safeParse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
    return parsed.success ? { value: parsed.data, configured: true } : { configured: true, error: `Invalid gateway session: ${reason(parsed.error)}` }
  } catch (error) {
    return { configured: true, error: `Could not read gateway session: ${reason(error)}` }
  }
}

function executable(path: string | undefined): boolean {
  if (!path) return false
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}

function api(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/orchestrator/api/${path}`
}

function gatewayApi(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/gateway/api/${path}`
}

/** Build a management route from a local loopback origin or a gateway deployment base. */
export function managementApi(target: FleetNativeTarget, path: string): string {
  return target.remote ? `${target.url.replace(/\/$/, '')}/${path}` : api(target.url, path)
}

async function json<T extends z.ZodType>(url: string, schema: T, token: string, timeoutMs = 2_500): Promise<z.infer<T>> {
  const response = await fetch(url, {
    headers: { 'x-orchestrator-request': '1', 'x-dsh-superagent-native': token, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).pathname}`)
  return schema.parse(await response.json() as unknown)
}

async function requestJson<T extends z.ZodType>(url: string, schema: T, init: RequestInit,
  acceptedStatuses: readonly number[] = []): Promise<z.infer<T>> {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(10_000) })
  const value = await response.json().catch(() => {
    throw new JsonRequestError(response.status, `${response.status} from ${new URL(url).pathname}`)
  })
  if (!response.ok || response.status === 202 && !acceptedStatuses.includes(202)) {
    const problem = z.object({ error: z.string().optional(), status: z.string().optional() }).safeParse(value)
    throw new JsonRequestError(response.status, problem.success && problem.data.error ? problem.data.error
      : problem.success && problem.data.status ? problem.data.status
      : `${response.status} from ${new URL(url).pathname}`)
  }
  return schema.parse(value)
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

async function remoteLogTail(target: FleetNativeTarget): Promise<{ path: string; tail: string } | undefined> {
  const value = await json(managementApi(target, 'logs?lines=80'), RemoteLogs, target.token, 15_000)
  if (value.id !== target.id) throw new Error('Gateway returned logs for a different deployment')
  return { path: `journal:${target.id}`, tail: redactSensitive(value.tail) }
}

async function remoteStatus(target: FleetNativeTarget): Promise<{ status: FleetStatus; detail: string } | undefined> {
  const value = await json(managementApi(target, 'status'), RemoteStatus, target.token, 15_000)
  if (value.id !== target.id) throw new Error('Gateway returned status for a different deployment')
  if (value.state === 'activating' || value.state === 'deactivating') return { status: 'starting', detail: 'Starting' }
  if (value.state === 'inactive') return { status: 'stopped', detail: 'Stopped intentionally' }
  if (value.state === 'failed') return { status: 'error', detail: 'Deployment service failed' }
  if (value.state === 'active' || value.state === 'reloading') return undefined
  return { status: 'unreachable', detail: `Deployment service is ${redactSensitive(value.state)}` }
}

async function snapshot(
  target: FleetNativeTarget,
  logDir: string | undefined,
  canControl: boolean,
  remoteLogs = false,
): Promise<FleetDeploymentView> {
  try {
    const state = await json(managementApi(target, 'state'), State, target.token)
    const [tickets, threads] = await Promise.all([
      json(managementApi(target, 'tickets?state=open&limit=1000'), Tickets, target.token)
        .catch(() => emptyTickets.parse({})),
      json(managementApi(target, 'threads?filter=recent&limit=20'), Threads, target.token)
        .catch(() => emptyThreads.parse({})),
    ])
    const status = statusOf(state)
    const stage = (value: string) => tickets.items.filter(ticket => ticket.stage.stage === value).length
    const repository = state.setup.accounts?.repository || target.repository
    return {
      id: target.id,
      remote: target.remote,
      name: title({ repository: target.repository }, repository),
      repository,
      profile: target.profile,
      url: target.url,
      stateDir: target.stateDir,
      workspace: target.workspace,
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
      log: remoteLogs ? await remoteLogTail(target).catch(() => undefined) : logTail(logDir, target.profile),
      canControl,
    }
  } catch (error) {
    const remote = target.remote && canControl
      ? await remoteStatus(target).catch(() => undefined)
      : undefined
    const localStopped = stopped(logDir, target.profile)
    return {
      id: target.id,
      remote: target.remote,
      name: title({ repository: target.repository }),
      repository: target.repository,
      profile: target.profile,
      url: target.url,
      stateDir: target.stateDir,
      workspace: target.workspace,
      status: remote?.status ?? (localStopped ? 'stopped' : 'unreachable'),
      detail: remote?.detail ?? (localStopped ? 'Stopped intentionally' : redactSensitive(reason(error))),
      health: [],
      load: { running: 0, queued: 0, maxWorkers: 0 },
      tickets: { open: 0, pending: 0, working: 0, idle: 0, recent: [] },
      triggers: { pending: 0, evaluating: 0, recent: [] },
      log: remoteLogs ? await remoteLogTail(target).catch(() => undefined) : logTail(logDir, target.profile),
      canControl,
    }
  }
}

export type FleetAction = 'start' | 'stop' | 'restart'

/** Aggregate repository-bound deployments and control only profiles present in the local registry. */
export class Fleet {
  readonly registryPath: string
  readonly gatewaySessionPath: string
  private readonly selectionPath: string
  private readonly busy = new Set<string>()
  private claude?: {
    server: Server
    port: number
    expiresAt: number
    url: string
    timer: ReturnType<typeof setTimeout>
  }
  constructor(readonly stateDir: string,
    private readonly options: { claudeCallbackPort?: number; now?: () => number } = {}) {
    this.registryPath = join(stateDir, 'fleet.json')
    this.gatewaySessionPath = join(stateDir, 'gateway.json')
    this.selectionPath = join(stateDir, 'native-deployment.json')
  }

  private localTarget(deployment: DeploymentConfig): FleetNativeTarget {
    return {
      id: deployment.id,
      remote: false,
      url: deployment.url,
      nativeUrl: deployment.url,
      repository: deployment.repository,
      profile: deployment.profile,
      stateDir: deployment.stateDir,
      workspace: deployment.workspace,
      token: nativeToken(deployment.stateDir, false) ?? '',
    }
  }

  private remoteTarget(session: AuthenticatedGatewaySession, deployment: RemoteDeployment): FleetNativeTarget {
    return {
      id: deployment.id,
      remote: true,
      url: `${session.url.replace(/\/$/, '')}/gateway/api/deployment/${deployment.id}`,
      nativeUrl: `${session.url.replace(/\/$/, '')}/gateway/native/${deployment.id}`,
      repository: deployment.repository,
      profile: deployment.profile,
      stateDir: '',
      workspace: '',
      token: session.token,
    }
  }

  private async remoteTargets(): Promise<{ value?: z.infer<typeof GatewayFleet>; error?: string; configured: boolean }> {
    const loaded = loadGatewaySession(this.gatewaySessionPath)
    if (loaded.error) return { configured: true, error: loaded.error }
    if (!loaded.value?.token) return { configured: true }
    const token = loaded.value.token
    try {
      const value = await requestJson(gatewayApi(loaded.value.url, 'fleet'), GatewayFleet, {
        headers: { accept: 'application/json', 'x-orchestrator-request': '1', 'x-dsh-superagent-native': token },
      })
      return { configured: true, value }
    } catch (error) {
      return { configured: true, error: `Gateway fleet is unavailable: ${reason(error)}` }
    }
  }

  private localTargets(loaded: ReturnType<typeof loadRegistry>): FleetNativeTarget[] {
    return (loaded.value?.deployments ?? []).map(deployment => this.localTarget(deployment))
  }

  async view(): Promise<FleetView> {
    const loaded = loadRegistry(this.registryPath)
    const [local, remote] = await Promise.all([Promise.resolve(loaded), this.remoteTargets()])
    const control = loaded.value?.controlScript
    const logDir = loaded.value?.logDir
    const localDeployments = this.localTargets(local)
    const localIds = new Set(localDeployments.map(target => target.id))
    const duplicates = (remote.value?.deployments ?? []).filter(deployment => localIds.has(deployment.id))
    const gatewaySession = loadGatewaySession(this.gatewaySessionPath)
    const session = gatewaySession.value
    const token = session?.token
    const remoteDeployments = session !== undefined && token !== undefined && remote.value
      ? remote.value.deployments
        .filter(deployment => !localIds.has(deployment.id))
        .map(deployment => ({
          target: this.remoteTarget({ url: session.url, token }, deployment),
          capabilities: new Set(deployment.capabilities),
        }))
      : []
    const deployments = await Promise.all([
      ...localDeployments.map(target => snapshot(target, logDir, executable(control))),
      ...remoteDeployments.map(item => snapshot(
        item.target,
        undefined,
        item.capabilities.has('lifecycle'),
        item.capabilities.has('logs'),
      )),
    ])
    const selected = this.selectedId()
    const gatewayError = remote.error ?? gatewaySession.error ?? (duplicates.length ? `Remote deployment id already exists locally: ${duplicates.map(item => item.id).join(', ')}` : undefined)
    return {
      configured: loaded.configured,
      ...session ? { gateway: {
        url: session.url,
        ...remote.value ? { organization: remote.value.organization, login: remote.value.login, person: remote.value.person } : {},
        ...gatewayError ? { error: gatewayError } : {},
      } } : remote.configured && gatewayError ? { gateway: { url: '', error: gatewayError } } : {},
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
    if (!deployment) {
      const remote = await this.remoteTargets()
      const remoteDeployment = remote.value?.deployments.find(item => item.id === id)
      if (remoteDeployment) {
        if (!remoteDeployment.capabilities.includes('lifecycle')) {
          throw new FleetControlError(409, `Lifecycle control is unavailable for the remote deployment ${id}`)
        }
        if (this.busy.has(id)) throw new FleetControlError(409, `Another lifecycle action is already running for ${id}`)
        this.busy.add(id)
        try {
          const session = this.authenticatedGatewaySession()
          const target = this.remoteTarget(session, remoteDeployment)
          const result = await requestJson(managementApi(target, 'lifecycle'), RemoteLifecycle, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json',
              'x-orchestrator-request': '1', 'x-dsh-superagent-native': target.token },
            body: JSON.stringify({ action }),
            signal: AbortSignal.timeout(310_000),
          })
          if (result.id !== id || result.action !== action) {
            throw new FleetControlError(502, 'Gateway returned a different lifecycle result')
          }
          return { id, action, code: 0,
            output: redactSensitive(result.output || `${action} completed (${result.state})`) }
        } catch (error) {
          if (error instanceof FleetControlError) throw error
          if (error instanceof JsonRequestError) {
            const status = error.status === 400 || error.status === 404 || error.status === 409 || error.status === 502
              ? error.status : 502
            throw new FleetControlError(status, redactSensitive(error.message))
          }
          throw new FleetControlError(502, redactSensitive(reason(error)))
        } finally {
          this.busy.delete(id)
        }
      }
      if (remote.error) throw new FleetControlError(502, remote.error)
      throw new FleetControlError(404, `Deployment not found: ${id}`)
    }
    const script = loaded.value?.controlScript
    if (!executable(script) || !script) throw new FleetControlError(400, 'The configured fleet control script is not executable')
    if (this.busy.has(id)) throw new FleetControlError(409, `Another lifecycle action is already running for ${id}`)
    this.busy.add(id)
    try {
      const args = [action, '--profile', deployment.profile, '--url', deployment.url, '--state-dir', deployment.stateDir]
      if (action !== 'start') args.push('--stop-timeout', '60')
      const result = await run(script, args)
      if (![0, 2, 3].includes(result.code)) throw new FleetControlError(400, result.output || `${action} failed`)
      return { id, action, ...result, output: redactSensitive(result.output) }
    } finally { this.busy.delete(id) }
  }

  /** Resolve a local deployment only from the validated registry. */
  private localManagementTarget(deployment: DeploymentConfig): FleetNativeTarget {
    const target = this.localTarget(deployment)
    if (target.token === '') throw new FleetControlError(400, `Deployment native capability is missing for ${deployment.id}`)
    return target
  }

  /** Resolve a local or gateway deployment from validated controller state. */
  async managementTarget(id: string): Promise<FleetNativeTarget> {
    const loaded = loadRegistry(this.registryPath)
    if (loaded.error) throw new FleetControlError(400, loaded.error)
    const deployment = loaded.value?.deployments.find(item => item.id === id)
    if (deployment) return this.localManagementTarget(deployment)
    const remote = await this.remoteTargets()
    if (remote.value?.deployments.some(item => item.id === id)) {
      const loaded = loadGatewaySession(this.gatewaySessionPath)
      if (loaded.error) throw new FleetControlError(502, loaded.error)
      const session = loaded.value
      if (session?.token === undefined) throw new FleetControlError(502, 'Gateway sign-in required')
      return this.remoteTarget({ url: session.url, token: session.token }, remote.value.deployments.find(item => item.id === id)!)
    }
    if (remote.error) throw new FleetControlError(502, remote.error)
    throw new FleetControlError(404, `Deployment not found: ${id}`)
  }

  async gatewayStatus(): Promise<{ configured: boolean; url?: string; organization?: string; login?: string; person?: boolean; error?: string }> {
    const loaded = loadGatewaySession(this.gatewaySessionPath)
    if (!loaded.value) return { configured: loaded.configured, ...loaded.error ? { error: loaded.error } : {} }
    if (loaded.value.token === undefined) return { configured: true, url: loaded.value.url }
    const remote = await this.remoteTargets()
    return {
      configured: true,
      url: loaded.value.url,
      ...remote.value ? { organization: remote.value.organization, login: remote.value.login, person: remote.value.person } : {},
      ...remote.error ? { error: remote.error } : {},
    }
  }

  async startGatewayDevice(): Promise<z.infer<typeof GatewayDevice>> {
    const loaded = loadGatewaySession(this.gatewaySessionPath)
    if (loaded.error) throw new FleetControlError(400, loaded.error)
    if (!loaded.value) throw new FleetControlError(400, 'The gateway address is not configured')
    try {
      return await requestJson(gatewayApi(loaded.value.url, 'device'), GatewayDevice, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: '{}',
      })
    } catch (error) {
      throw new FleetControlError(502, `Gateway sign-in is unavailable: ${reason(error)}`)
    }
  }

  async completeGatewaySession(deviceCode: string): Promise<{ login: string; organization: string; expiresAt: string }> {
    const loaded = loadGatewaySession(this.gatewaySessionPath)
    if (loaded.error) throw new FleetControlError(400, loaded.error)
    if (!loaded.value) throw new FleetControlError(400, 'The gateway address is not configured')
    let session: z.infer<typeof GatewaySession>
    try {
      session = await requestJson(gatewayApi(loaded.value.url, 'session'), GatewaySession, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: deviceCode }),
      })
    } catch (error) {
      throw new FleetControlError(502, `Gateway sign-in failed: ${reason(error)}`)
    }
    const temporary = `${this.gatewaySessionPath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, url: loaded.value.url, token: session.nativeToken })}\n`, { mode: 0o600 })
    renameSync(temporary, this.gatewaySessionPath)
    return { login: session.login, organization: session.organization, expiresAt: session.expiresAt }
  }

  private authenticatedGatewaySession(): { url: string; token: string } {
    const loaded = loadGatewaySession(this.gatewaySessionPath)
    if (loaded.error) throw new FleetControlError(400, loaded.error)
    if (!loaded.value) throw new FleetControlError(400, 'The gateway address is not configured')
    if (loaded.value.token === undefined) throw new FleetControlError(400, 'Gateway sign-in required')
    return { url: loaded.value.url, token: loaded.value.token }
  }

  async createGatewayPerson(): Promise<z.infer<typeof GatewayPerson>> {
    const session = this.authenticatedGatewaySession()
    try {
      return await requestJson(gatewayApi(session.url, 'person'), GatewayPerson, {
        method: 'POST',
        headers: { accept: 'application/json', 'x-orchestrator-request': '1', 'x-dsh-superagent-native': session.token },
      })
    } catch (error) {
      throw new FleetControlError(502, `Gateway onboarding failed: ${reason(error)}`)
    }
  }

  async createGatewayDeployment(id: string, repository: string): Promise<z.infer<typeof GatewayDeployment>> {
    const session = this.authenticatedGatewaySession()
    try {
      return await requestJson(gatewayApi(session.url, 'deployment'), GatewayDeployment, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json',
          'x-orchestrator-request': '1', 'x-dsh-superagent-native': session.token },
        body: JSON.stringify({ id, repository }),
      })
    } catch (error) {
      throw new FleetControlError(502, `Gateway onboarding failed: ${reason(error)}`)
    }
  }

  async configureGatewayDeploymentCredentials(id: string, githubToken: string): Promise<z.infer<typeof GatewayCredentials>> {
    const session = this.authenticatedGatewaySession()
    try {
      return await requestJson(gatewayApi(session.url, `deployment/${id}/credentials`), GatewayCredentials, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json',
          'x-orchestrator-request': '1', 'x-dsh-superagent-native': session.token },
        body: JSON.stringify({ githubToken }),
      })
    } catch (error) {
      throw new FleetControlError(502, `Gateway credential setup failed: ${reason(error)}`)
    }
  }

  async signOutGateway(): Promise<{ signedOut: true }> {
    const loaded = loadGatewaySession(this.gatewaySessionPath)
    if (loaded.error) throw new FleetControlError(400, loaded.error)
    if (loaded.value !== undefined) {
      const temporary = `${this.gatewaySessionPath}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ version: 1, url: loaded.value.url })}\n`, { mode: 0o600 })
      renameSync(temporary, this.gatewaySessionPath)
    }
    return { signedOut: true }
  }

  async modelProxyStatus(): Promise<ModelProxyView> {
    const session = this.authenticatedGatewaySession()
    try {
      return await requestJson(gatewayApi(session.url, 'model-proxy'), ModelProxy, {
        headers: { accept: 'application/json', 'x-orchestrator-request': '1',
          'x-dsh-superagent-native': session.token },
      })
    } catch (error) {
      throw new FleetControlError(502, `Model proxy status is unavailable: ${reason(error)}`)
    }
  }

  async setModelProviderKey(provider: 'one-nexus' | 'openai', apiKey: string):
  Promise<{ provider: 'one-nexus' | 'openai'; configured: true }> {
    const session = this.authenticatedGatewaySession()
    try {
      return await requestJson(gatewayApi(session.url, `model-proxy/provider/${provider}`), z.object({
        provider: z.enum(['one-nexus', 'openai']), configured: z.literal(true),
      }), {
        method: 'PUT',
        headers: { accept: 'application/json', 'content-type': 'application/json',
          'x-orchestrator-request': '1', 'x-dsh-superagent-native': session.token },
        body: JSON.stringify({ apiKey }),
      })
    } catch (error) {
      throw new FleetControlError(502, `Model provider setup failed: ${reason(error)}`)
    }
  }

  async createModelProxyKey(id: string): Promise<z.infer<typeof ModelProxyKey>> {
    const session = this.authenticatedGatewaySession()
    try {
      const value = await requestJson(gatewayApi(session.url, `model-proxy/deployment/${id}/key`), ModelProxyKey, {
        method: 'POST',
        headers: { accept: 'application/json', 'x-orchestrator-request': '1',
          'x-dsh-superagent-native': session.token },
      })
      if (value.id !== id) throw new Error('Gateway returned a key for a different deployment')
      return value
    } catch (error) {
      if (error instanceof FleetControlError) throw error
      throw new FleetControlError(502, `Model proxy key creation failed: ${reason(error)}`)
    }
  }

  async revokeModelProxyKey(id: string, value: string): Promise<void> {
    const session = this.authenticatedGatewaySession()
    try {
      await requestJson(gatewayApi(session.url, `model-proxy/deployment/${id}/key`), z.object({
        id: z.string(), revoked: z.literal(true),
      }), {
        method: 'DELETE',
        headers: { accept: 'application/json', 'content-type': 'application/json',
          'x-orchestrator-request': '1', 'x-dsh-superagent-native': session.token },
        body: JSON.stringify({ value }),
      })
    } catch (error) {
      throw new FleetControlError(502, `Model proxy key rollback failed: ${reason(error)}`)
    }
  }

  async finalizeModelProxyKey(id: string, keep: string): Promise<void> {
    const session = this.authenticatedGatewaySession()
    try {
      await requestJson(gatewayApi(session.url, `model-proxy/deployment/${id}/key/finalize`), z.object({
        id: z.string(), pruned: z.literal(true),
      }), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json',
          'x-orchestrator-request': '1', 'x-dsh-superagent-native': session.token },
        body: JSON.stringify({ keep }),
      })
    } catch (error) {
      throw new FleetControlError(502, `Model proxy key finalization failed: ${reason(error)}`)
    }
  }

  async startClaudeLogin(): Promise<{ url: string; expiresAt: string }> {
    if (this.claude !== undefined && this.claude.expiresAt > this.now()) {
      return { url: this.claude.url, expiresAt: new Date(this.claude.expiresAt).toISOString() }
    }
    this.closeClaude()
    const server = await this.bindClaudeCallback()
    const address = server.address() as AddressInfo
    const session = this.authenticatedGatewaySession()
    try {
      const value = await requestJson(gatewayApi(session.url, 'model-proxy/claude/connect'), ClaudeConnect, {
        method: 'POST',
        headers: { accept: 'application/json', 'x-orchestrator-request': '1',
          'x-dsh-superagent-native': session.token },
      })
      const expiresAt = Date.parse(value.expiresAt)
      const timer = setTimeout(() => this.closeClaude(), Math.min(2_147_483_647, Math.max(0, expiresAt - this.now())))
      this.claude = { server, port: address.port, expiresAt, url: value.url, timer }
      return { url: value.url, expiresAt: value.expiresAt }
    } catch (error) {
      server.close()
      if (error instanceof FleetControlError) throw error
      throw new FleetControlError(502, `Claude login could not start: ${reason(error)}`)
    }
  }

  async claudeLoginStatus(): Promise<z.infer<typeof ClaudeStatus>> {
    if (this.claude === undefined) return { state: 'idle' }
    const session = this.authenticatedGatewaySession()
    try {
      const value = await requestJson(gatewayApi(session.url, 'model-proxy/claude/status'), ClaudeStatus, {
        headers: { accept: 'application/json', 'x-orchestrator-request': '1',
          'x-dsh-superagent-native': session.token },
      })
      if (value.state === 'connected' || value.state === 'error' || value.state === 'idle') this.closeClaude()
      return value
    } catch (error) {
      throw new FleetControlError(502, `Claude login status is unavailable: ${reason(error)}`)
    }
  }

  async cancelClaudeLogin(): Promise<{ cancelled: boolean }> {
    if (this.claude === undefined) return { cancelled: false }
    const session = this.authenticatedGatewaySession()
    try {
      const value = await requestJson(gatewayApi(session.url, 'model-proxy/claude/session'), z.object({
        cancelled: z.boolean(),
      }), {
        method: 'DELETE',
        headers: { accept: 'application/json', 'x-orchestrator-request': '1',
          'x-dsh-superagent-native': session.token },
      })
      this.closeClaude()
      return value
    } catch (error) {
      throw new FleetControlError(502, `Claude login cancellation failed: ${reason(error)}`)
    }
  }

  dispose(): void {
    this.closeClaude()
  }

  private async bindClaudeCallback(): Promise<Server> {
    const server = createServer((request, response) => {
      void this.handleClaudeCallback(request.url ?? '/', response)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const failure = (error: NodeJS.ErrnoException): void => reject(error)
        server.once('error', failure)
        server.listen(this.options.claudeCallbackPort ?? 54_545, '127.0.0.1', () => {
          server.off('error', failure)
          resolve()
        })
      })
      return server
    } catch (error) {
      server.close()
      const code = (error as NodeJS.ErrnoException).code
      const port = this.options.claudeCallbackPort ?? 54_545
      throw new FleetControlError(409, code === 'EADDRINUSE'
        ? `Port ${port} is already in use. Close the other Claude sign-in window and try again.`
        : `Could not open the Claude callback listener: ${reason(error)}`)
    }
  }

  private async handleClaudeCallback(raw: string, response: ServerResponse): Promise<void> {
    const url = new URL(raw, 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      claudePage(response, 404, 'Not found', 'This is not a Claude authorization callback.')
      return
    }
    if (this.claude === undefined || this.claude.expiresAt <= this.now()) {
      claudePage(response, 410, 'Sign-in expired', 'Return to DeepSeek Harness and start again.')
      this.closeClaude()
      return
    }
    const code = url.searchParams.get('code') ?? undefined
    const error = url.searchParams.get('error') ?? undefined
    const state = url.searchParams.get('state') ?? undefined
    if (state === undefined || code === undefined && error === undefined) {
      claudePage(response, 400, 'Incomplete authorization', 'Return to DeepSeek Harness and start again.')
      return
    }
    const session = this.authenticatedGatewaySession()
    try {
      await requestJson(gatewayApi(session.url, 'model-proxy/claude/callback'), z.object({
        accepted: z.literal(true),
      }), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json',
          'x-orchestrator-request': '1', 'x-dsh-superagent-native': session.token },
        body: JSON.stringify({ state, ...code === undefined ? {} : { code }, ...error === undefined ? {} : { error } }),
      }, [202])
      claudePage(response, 200, 'Authorization received',
        'Return to DeepSeek Harness. The connection will finish automatically; you can close this tab.')
    } catch {
      claudePage(response, 400, 'Authorization could not be completed',
        'Return to DeepSeek Harness, check the connection state, and start again.')
    }
  }

  private closeClaude(): void {
    if (this.claude === undefined) return
    clearTimeout(this.claude.timer)
    this.claude.server.close()
    this.claude = undefined
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** Select the deployment whose native DSH state and streams the Desktop controller serves. */
  async select(id: string): Promise<{ selected: string }> {
    await this.managementTarget(id)
    const temporary = `${this.selectionPath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, deployment: id })}\n`, { mode: 0o600 })
    renameSync(temporary, this.selectionPath)
    return { selected: id }
  }

  /** Resolve the selected deployment, or undefined before the first selection. */
  async nativeTarget(): Promise<FleetNativeTarget | undefined> {
    const id = this.selectedId()
    if (id === undefined) return undefined
    return this.managementTarget(id)
  }

  /** Resolve every validated deployment as an independently authenticated native peer. */
  async nativeTargets(): Promise<FleetNativeTarget[]> {
    const loaded = loadRegistry(this.registryPath)
    if (loaded.error) throw new FleetControlError(400, loaded.error)
    const local = (loaded.value?.deployments ?? []).map(deployment => this.localManagementTarget(deployment))
    const remote = await this.remoteTargets()
    const localIds = new Set(local.map(target => target.id))
    const session = loadGatewaySession(this.gatewaySessionPath)
    if (session.error || !session.value?.token) return local
    const gatewaySession = { url: session.value.url, token: session.value.token }
    return [...local, ...(remote.value?.deployments ?? [])
      .filter(deployment => !localIds.has(deployment.id))
      .map(deployment => this.remoteTarget(gatewaySession, deployment))]
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

function claudePage(response: ServerResponse, status: number, heading: string, detail: string): void {
  const escape = (value: string): string => value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  })
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escape(heading)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:38rem;margin:12vh auto;padding:2rem;color:#172019}
h1{font-size:1.6rem;margin:0 0 .75rem}p{color:#52605a}</style><h1>${escape(heading)}</h1><p>${escape(detail)}</p></html>`)
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
