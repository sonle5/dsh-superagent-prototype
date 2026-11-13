/** Loopback-only management HTTP routes with same-origin enforcement for the web panel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { DEPLOYMENT_ROUTES, THREAD_FILTERS, TICKET_FILTERS, matchesRoute, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { sourceSkills } from './context.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion } from '../policy.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { UserError, type EngineForPeople, type Ticket } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'
import { Fleet, FleetControlError, managementApi, redactSensitive, type FleetAction, type FleetNativeTarget } from './fleet.ts'
import { INTERNAL_HEADER } from './native-transport.ts'
import { matchesNativeToken } from './native-auth.ts'
import { ProviderControlError, configureDeploymentModelProxy, providerControl, resetProvider, saveProvider,
  setProviderCredential } from './providers.ts'
import { LIMITS } from '../limits.ts'

export interface HttpHost {
  readonly store: Store
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  readonly engine: EngineForPeople
  readonly executor: Pick<DshExecutor, 'activeCount'>
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
}
/**
 * Represents a client-facing 400, 404, 409 or 502 error raised during management route parsing, lookup, contention or forwarding.
 * Route handlers throw it when request bodies are malformed or target records are missing, and registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404 | 409 | 502, message: string) { super(message) } }
async function readBodyBytes(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  try { return JSON.parse((await readBodyBytes(req, maxBytes)).toString('utf8')) as unknown }
  catch (error) {
    if (error instanceof RouteError) throw error
    throw new RouteError(400, 'The request body is not JSON')
  }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  if (error instanceof ProviderControlError) return [error.status, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    accounts: resolved ? { repository: resolved.repository, agent: resolved.github.login, feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    masterId: runtime.masterId, paused: settings.paused, health: runtime.health }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem })
export type StateView = ReturnType<typeof stateView>
/** Builds a ticket's detail view; `environment` is empty while waiting for setup because it requires the resolved deployment. */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
}
type GatewayRouteKey = 'GET gateway/status' | 'POST gateway/device' | 'POST gateway/session' | 'DELETE gateway/session'
  | 'GET gateway/model-proxy' | 'POST gateway/model-proxy/claude/connect' | 'GET gateway/model-proxy/claude/status'
  | 'DELETE gateway/model-proxy/claude/session' | 'PUT gateway/model-proxy/provider/:provider'
  | 'POST gateway/person' | 'POST gateway/deployment' | 'POST gateway/deployment/:id/credentials'
type FleetRouteKey = 'GET fleet' | 'POST deployments/:id/select' | 'POST fleet/:id/start' | 'POST fleet/:id/stop'
  | 'POST fleet/:id/restart' | 'POST fleet/:id/model-proxy'
type ControllerRouteKey = GatewayRouteKey | FleetRouteKey
type ProviderRouteKey = 'GET fleet/:id/providers' | 'PUT fleet/:id/providers/:provider'
  | 'POST fleet/:id/providers/:provider/credential' | 'DELETE fleet/:id/providers/:provider'
type RouteHandler<K extends keyof Api> = (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>>
type Routes = { [K in Exclude<keyof Api, GatewayRouteKey | ProviderRouteKey>]: RouteHandler<K> }
type ControllerRoutes = { [K in ControllerRouteKey | ProviderRouteKey]: RouteHandler<K> }
type RouteTable = { [K in keyof Api]?: RouteHandler<K> }
const NATIVE_CONTROLLER_ROUTES = new Set<keyof Api>([
  'GET gateway/model-proxy',
  'POST gateway/model-proxy/claude/connect',
  'GET gateway/model-proxy/claude/status',
  'DELETE gateway/model-proxy/claude/session',
  'PUT gateway/model-proxy/provider/:provider',
  'POST gateway/deployment/:id/credentials',
  'POST fleet/:id/model-proxy',
])
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor']), SourceBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })

function routes(runtime: HttpHost, fleet: Fleet): Routes {
  const { store } = runtime
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  const control = async <A extends FleetAction>(id: string, action: A): Promise<{ id: string; action: A; code: number; output: string }> => {
    try { return { ...await fleet.control(id, action), action } }
    catch (error) {
      if (error instanceof FleetControlError) throw new RouteError(error.status, error.message)
      throw error
    }
  }
  const select = async (id: string): Promise<{ selected: string }> => {
    try { return await fleet.select(id) }
    catch (error) {
      if (error instanceof FleetControlError) throw new RouteError(error.status, error.message)
      throw error
    }
  }
  return {
    'GET fleet': () => fleet.view(),
    'POST deployments/:id/select': async ({ params }) => select(params.id),
    'POST fleet/:id/start': ({ params }) => control(params.id, 'start'),
    'POST fleet/:id/stop': ({ params }) => control(params.id, 'stop'),
    'POST fleet/:id/restart': ({ params }) => control(params.id, 'restart'),
    'POST fleet/:id/model-proxy': ({ params }) => configureDeploymentModelProxy(fleet, params.id),
    'GET state': () => stateView(runtime),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir),
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/stop': ({ params }) => { const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    'GET models': () => runtime.models(),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
  }
}
function controllerRoutes(fleet: Fleet): ControllerRoutes {
  const control = async <A extends FleetAction>(id: string, action: A): Promise<{ id: string; action: A; code: number; output: string }> => {
    try { return { ...await fleet.control(id, action), action } }
    catch (error) {
      if (error instanceof FleetControlError) throw new RouteError(error.status, error.message)
      throw error
    }
  }
  const select = async (id: string): Promise<{ selected: string }> => {
    try { return await fleet.select(id) }
    catch (error) {
      if (error instanceof FleetControlError) throw new RouteError(error.status, error.message)
      throw error
    }
  }
  const gateway = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work() }
    catch (error) {
      if (error instanceof FleetControlError) throw new RouteError(error.status, error.message)
      throw error
    }
  }
  return {
    'GET fleet': () => fleet.view(),
    'GET gateway/status': () => fleet.gatewayStatus(),
    'POST gateway/device': () => gateway(() => fleet.startGatewayDevice()),
    'POST gateway/session': async ({ body }) => gateway(async () => {
      const request = z.object({ device_code: z.string().min(1) }).parse(await body())
      return fleet.completeGatewaySession(request.device_code)
    }),
    'DELETE gateway/session': () => gateway(() => fleet.signOutGateway()),
    'GET gateway/model-proxy': () => gateway(() => fleet.modelProxyStatus()),
    'POST gateway/model-proxy/claude/connect': () => gateway(() => fleet.startClaudeLogin()),
    'GET gateway/model-proxy/claude/status': () => gateway(() => fleet.claudeLoginStatus()),
    'DELETE gateway/model-proxy/claude/session': () => gateway(() => fleet.cancelClaudeLogin()),
    'PUT gateway/model-proxy/provider/:provider': async ({ params, body }) => gateway(async () => {
      const provider = z.enum(['one-nexus', 'openai']).parse(params.provider)
      const request = z.object({ apiKey: z.string().min(1).max(16_384) }).parse(await body())
      return fleet.setModelProviderKey(provider, request.apiKey)
    }),
    'POST gateway/person': () => gateway(() => fleet.createGatewayPerson()),
    'POST gateway/deployment': async ({ body }) => gateway(async () => {
      const request = z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase deployment id'),
        repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/repository'),
      }).parse(await body())
      return fleet.createGatewayDeployment(request.id, request.repository)
    }),
    'POST gateway/deployment/:id/credentials': async ({ params, body }) => gateway(async () => {
      const request = z.object({ githubToken: z.string().regex(/^[A-Za-z0-9_-]{20,255}$/, 'GitHub token') })
        .parse(await body())
      return fleet.configureGatewayDeploymentCredentials(params.id, request.githubToken)
    }),
    'POST deployments/:id/select': ({ params }) => select(params.id),
    'POST fleet/:id/start': ({ params }) => control(params.id, 'start'),
    'POST fleet/:id/stop': ({ params }) => control(params.id, 'stop'),
    'POST fleet/:id/restart': ({ params }) => control(params.id, 'restart'),
    'POST fleet/:id/model-proxy': ({ params }) => configureDeploymentModelProxy(fleet, params.id),
    'GET fleet/:id/providers': ({ params }) => providerControl(fleet, params.id),
    'PUT fleet/:id/providers/:provider': async ({ params, body }) =>
      saveProvider(fleet, params.id, params.provider, await body()),
    'POST fleet/:id/providers/:provider/credential': async ({ params, body }) =>
      setProviderCredential(fleet, params.id, params.provider, await body()),
    'DELETE fleet/:id/providers/:provider': async ({ params, body }) =>
      resetProvider(fleet, params.id, params.provider, await body()),
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: RouteTable, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { key: route as keyof Api, run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
function registerManagement(ctx: Context, stateDir: string, runtime?: HttpHost): () => void {
  const requiredHost = runtime ? 'Orchestrator management' : 'Fleet control'
  if (ctx.webServer.host !== '127.0.0.1') throw new Error(`${requiredHost} requires a loopback Web server`)
  const fleet = new Fleet(stateDir)
  const table: RouteTable = runtime ? routes(runtime, fleet) : controllerRoutes(fleet)
  const deploymentPath = /^\/orchestrator\/api\/deployment\/([a-z0-9][a-z0-9-]*)\/(.+)$/
  const forward = async (req: IncomingMessage, url: URL, id: string, suffix: string) => {
    const method = req.method ?? 'GET'
    // Fleet lifecycle belongs to the control plane. A deployment exposes only its own management API.
    if (!matchesRoute(DEPLOYMENT_ROUTES, method, suffix.split('/'))) throw new RouteError(404, 'Unknown operation')
    let target: FleetNativeTarget
    try { target = await fleet.managementTarget(id) }
    catch (error) {
      if (error instanceof FleetControlError) throw new RouteError(error.status, error.message)
      throw error
    }
    const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0)
      : await readBodyBytes(req, 4 * LIMITS.promptMaxChars.max + 4096)
    const payload = raw.toString('utf8')
    const targetUrl = new URL(managementApi(target, suffix), target.url)
    targetUrl.search = url.search
    let response: Response
    try {
      response = await fetch(targetUrl, {
        method,
        headers: { accept: 'application/json', 'x-orchestrator-request': '1', 'x-dsh-superagent-native': target.token,
          ...payload ? { 'content-type': 'application/json' } : {} },
        ...payload ? { body: payload } : {},
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      throw new RouteError(502, redactSensitive(`Deployment unavailable: ${error instanceof Error ? error.message : String(error)}`))
    }
    const text = await response.text()
    try { return { status: response.status, body: JSON.parse(response.ok ? text : redactSensitive(text)) as unknown } }
    catch { return { status: response.status, body: { error: redactSensitive(text || response.statusText) } } }
  }
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      const native = matchesNativeToken(stateDir, req.headers[INTERNAL_HEADER])
      if (!native) {
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          json(res, rejection, { error: rejection === 401
            ? 'Signed-in management request required' : 'Trusted management request required' })
          return
        }
      }
      try {
        await runtime?.ready
        const deployment = deploymentPath.exec(url.pathname)
        if (deployment) {
          const result = await forward(req, url, deployment[1]!, deployment[2]!)
          json(res, result.status, result.body)
          return
        }
        const route = match(table, req.method ?? 'GET', url.pathname.slice('/orchestrator/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        if (NATIVE_CONTROLLER_ROUTES.has(route.key) && !native) {
          json(res, 403, { error: 'Trusted controller request required' })
          return
        }
        const query = Object.fromEntries(url.searchParams)
        json(res, 200, await route.run({ params: route.params as never, query, body: maxBytes => readBody(req, maxBytes) }))
      } catch (error) { json(res, ...failure(error)) }
    } })]
  return () => {
    for (const dispose of disposers) dispose()
    fleet.dispose()
  }
}
/** Register only Fleet lifecycle and the fixed deployment-management proxy. No repository runtime is created. */
export function registerControlHttp(ctx: Context, stateDir: string): () => void {
  return registerManagement(ctx, stateDir)
}
/** Register the repository management API together with Fleet lifecycle and its fixed deployment-management proxy. */
export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  return registerManagement(ctx, runtime.machine.stateDir, runtime)
}
