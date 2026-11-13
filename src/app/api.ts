/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'
import type { FleetView } from './fleet.ts'
import type { ProviderControlView } from './providers.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'
export type ModelProxyProviderId = 'claude' | 'nexus13' | 'one-nexus' | 'openai'
export interface ModelProxyView {
  status: string
  baseURL: string
  providers: {
    id: ModelProxyProviderId
    label: string
    state: 'connected' | 'configured' | 'sign-in-required' | 'missing' | 'error'
  }[]
  deployments: {
    id: string
    keyConfigured: boolean
  }[]
}

export interface Api {
  'GET fleet': { response: FleetView }
  'GET gateway/status': { response: {
    configured: boolean
    url?: string
    organization?: string
    login?: string
    person?: boolean
    error?: string
  } }
  'POST gateway/device': { response: {
    device_code: string
    user_code: string
    verification_uri: string
    expires_in: number
    interval: number
  } }
  'POST gateway/session': { body: { device_code: string }; response: { login: string; organization: string; expiresAt: string } }
  'POST gateway/person': { response: {
    login: string
    user?: string
    created: boolean
  } }
  'POST gateway/deployment': { body: { id: string; repository: string }; response: {
    login: string
    created: boolean
    deployment: {
      id: string
      profile: string
      repository: string
      url: string
      stateDir: string
      workspace: string
    }
  } }
  'POST gateway/deployment/:id/credentials': { body: { githubToken: string }; response: {
    saved: boolean
    revision: number
    restarting: boolean
  } }
  'DELETE gateway/session': { response: { signedOut: true } }
  'GET gateway/model-proxy': { response: ModelProxyView }
  'POST gateway/model-proxy/claude/connect': { response: { url: string; expiresAt: string } }
  'GET gateway/model-proxy/claude/status': { response: {
    state: 'idle' | 'waiting' | 'connected' | 'error'
    error?: string
  } }
  'DELETE gateway/model-proxy/claude/session': { response: { cancelled: boolean } }
  'PUT gateway/model-proxy/provider/:provider': { body: { apiKey: string }; response: {
    provider: 'one-nexus' | 'openai'
    configured: true
  } }
  'POST fleet/:id/model-proxy': { response: ProviderControlView }
  'POST deployments/:id/select': { response: { selected: string } }
  'POST fleet/:id/start': { response: { id: string; action: 'start'; code: number; output: string } }
  'POST fleet/:id/stop': { response: { id: string; action: 'stop'; code: number; output: string } }
  'POST fleet/:id/restart': { response: { id: string; action: 'restart'; code: number; output: string } }
  'GET fleet/:id/providers': { response: ProviderControlView }
  'PUT fleet/:id/providers/:provider': { body: {
    displayName: string
    api: 'openai-completions' | 'anthropic-messages' | 'openai-responses'
    baseURL: string
    credentialRef: string
    apiKey?: string
    models: {
      id: string
      name: string
      contextWindow?: number
      maxTokens?: number
      reasoning: boolean
      image: boolean
    }[]
    revision: number
  }; response: ProviderControlView }
  'POST fleet/:id/providers/:provider/credential': { body: { value: string }; response: ProviderControlView }
  'DELETE fleet/:id/providers/:provider': { body: { revision: number }; response: ProviderControlView }
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
export const FLEET_ROUTES = [
  'GET fleet',
  'GET gateway/status',
  'POST gateway/device',
  'POST gateway/session',
  'POST gateway/person',
  'POST gateway/deployment',
  'POST gateway/deployment/:id/credentials',
  'DELETE gateway/session',
  'GET gateway/model-proxy',
  'POST gateway/model-proxy/claude/connect',
  'GET gateway/model-proxy/claude/status',
  'DELETE gateway/model-proxy/claude/session',
  'PUT gateway/model-proxy/provider/:provider',
  'POST fleet/:id/model-proxy',
  'POST deployments/:id/select',
  'POST fleet/:id/start',
  'POST fleet/:id/stop',
  'POST fleet/:id/restart',
  'GET fleet/:id/providers',
  'PUT fleet/:id/providers/:provider',
  'POST fleet/:id/providers/:provider/credential',
  'DELETE fleet/:id/providers/:provider',
] as const satisfies readonly (keyof Api)[]
export const DEPLOYMENT_ROUTES = [
  'GET state',
  'GET overview',
  'GET search',
  'GET sources',
  'GET settings',
  'POST sources/:id/labels',
  'GET threads',
  'GET threads/:key',
  'POST threads/:key/unsubscribe',
  'POST triggers/:id/requeue',
  'GET decisions',
  'POST decisions/:id/dismiss',
  'GET tickets',
  'GET tickets/:id',
  'POST tickets/:id/retry',
  'POST tickets/:id/stop',
  'POST executor/pause',
  'PUT settings/:block',
  'GET policy/history',
  'POST policy-sync/:id',
  'POST setup/check',
  'GET models',
  'GET prompts',
  'PUT prompts',
  'POST prompts/preview',
] as const satisfies readonly Exclude<keyof Api, typeof FLEET_ROUTES[number]>[]

type Assert<T extends true> = T
type _AllApiRoutesAreClassified = Assert<Exclude<keyof Api, typeof FLEET_ROUTES[number] | typeof DEPLOYMENT_ROUTES[number]> extends never
  ? true : false>

/** Match a method and already split path against one of the compiled route declarations. */
export function matchesRoute<T extends string>(routes: readonly T[], method: string, segments: readonly string[]): boolean {
  return routes.some(route => {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    return verb === method && pattern.length === segments.length
      && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
  })
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
