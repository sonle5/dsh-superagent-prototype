/** Deployment-scoped provider, credential, and model-catalog control over DSH's native settings APIs. */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { redactSensitive, type Fleet, type FleetNativeTarget } from './fleet.ts'
import { NativePeerRpcError, nativePeerRpc } from './native-transport.ts'

const Namespace = z.object({
  ns: z.string(),
  value: z.unknown(),
  user: z.unknown().optional(),
  revision: z.number().int().nonnegative(),
}).passthrough()
const Describe = z.object({
  writable: z.boolean(),
  namespaces: z.array(Namespace),
}).passthrough()
const RegisteredProvider = z.object({
  id: z.string(),
  name: z.string(),
}).passthrough()
const ConfigurableProvider = z.object({
  provider: z.string(),
  displayName: z.string(),
  settingsNs: z.string(),
  settingsPath: z.array(z.string()),
  defaultBaseURL: z.string().optional(),
  error: z.string().optional(),
}).passthrough()
const CredentialInfo = z.object({
  configured: z.boolean(),
  source: z.string().optional(),
  writable: z.boolean(),
}).passthrough()
const Catalog = z.object({
  default: z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() }).optional(),
  routableProviders: z.array(z.string()).optional(),
  groups: z.array(z.object({
    id: z.string(),
    name: z.string(),
    models: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
  }).passthrough()),
  failures: z.array(z.unknown()).optional(),
}).passthrough() as unknown as z.ZodType<ModelCatalog>

const ModelInput = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  reasoning: z.boolean().default(false),
  image: z.boolean().default(false),
})
export const ProviderInput = z.object({
  displayName: z.string().trim().min(1).max(100),
  api: z.enum(['openai-completions', 'anthropic-messages', 'openai-responses']),
  baseURL: z.string().trim().url().refine(value => {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  }, 'HTTP(S) URL'),
  credentialRef: z.string().trim().regex(/^[A-Z_][A-Z0-9_]*$/, 'Credential reference'),
  apiKey: z.string().min(1).max(16_384).optional(),
  models: z.array(ModelInput).min(1).max(50),
  revision: z.number().int().nonnegative(),
})
export type ProviderInput = z.infer<typeof ProviderInput>
export const CredentialInput = z.object({
  value: z.string().min(1).max(16_384),
})
export const ResetInput = z.object({
  revision: z.number().int().nonnegative(),
})

export interface ProviderModelView {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  reasoning: boolean
  image: boolean
}
export interface ProviderView {
  id: string
  displayName: string
  api?: string
  baseURL?: string
  credentialRef?: string
  credential?: { configured: boolean; source?: string; writable: boolean }
  models: ProviderModelView[]
  active: boolean
  configured: boolean
  removable: boolean
  error?: string
}
export interface ProviderControlView {
  writable: boolean
  revision: number
  providers: ProviderView[]
  catalog: ModelCatalog
  credentialError?: string
}

/** A provider-control refusal that retains the HTTP status the management route should expose. */
export class ProviderControlError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502, message: string) { super(message) }
}

type JsonRecord = Record<string, unknown>
type Rpc = (target: FleetNativeTarget, method: string, args: Record<string, unknown>) => Promise<unknown>

const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value)

function providerProfiles(value: unknown): Record<string, JsonRecord> {
  if (!isRecord(value) || !isRecord(value.providers)) return {}
  return Object.fromEntries(Object.entries(value.providers).filter((entry): entry is [string, JsonRecord] => isRecord(entry[1])))
}

function userProfile(value: unknown, id: string): JsonRecord | undefined {
  if (!isRecord(value) || !isRecord(value.providers)) return undefined
  const profile = value.providers[id]
  return isRecord(profile) ? profile : undefined
}

function pathValue(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const part of path) {
    if (!isRecord(current)) return undefined
    current = current[part]
  }
  return current
}

function modelViews(profile: JsonRecord): ProviderModelView[] {
  if (!Array.isArray(profile.models)) return []
  return profile.models.flatMap(item => {
    if (!isRecord(item) || typeof item.id !== 'string') return []
    const input = Array.isArray(item.input) ? item.input : []
    return [{
      id: item.id,
      name: typeof item.name === 'string' ? item.name : item.id,
      ...typeof item.contextWindow === 'number' ? { contextWindow: item.contextWindow } : {},
      ...typeof item.maxTokens === 'number' ? { maxTokens: item.maxTokens } : {},
      reasoning: isRecord(item.reasoningEfforts) && Object.keys(item.reasoningEfforts).length > 0,
      image: input.includes('image'),
    }]
  })
}

async function rpc(target: FleetNativeTarget, method: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await nativePeerRpc(target, method, args)
  } catch (error) {
    if (error instanceof NativePeerRpcError) {
      throw new ProviderControlError(error.code === 'settings/conflict' ? 409 : 502, redactSensitive(error.message))
    }
    throw error
  }
}

async function settings(target: FleetNativeTarget): Promise<z.infer<typeof Describe>> {
  return Describe.parse(await rpc(target, 'settings/describe', {}))
}

function reasoningEfforts(): Record<string, string | null> {
  return { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
}

function modelProfile(model: z.infer<typeof ModelInput>): JsonRecord {
  return {
    id: model.id,
    name: model.name,
    ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    input: model.image ? ['text', 'image'] : ['text'],
    reasoningEfforts: model.reasoning ? reasoningEfforts() : false,
  }
}

function profileFor(input: ProviderInput, existing: JsonRecord | undefined): JsonRecord {
  const compat = input.api === 'openai-completions'
    ? { maxTokensField: input.baseURL.includes('onenexus') ? 'max_tokens' : 'max_tokens',
      supportsReasoningEffort: input.models.some(model => model.reasoning),
      thinkingFormat: input.baseURL.includes('onenexus') ? 'qwen' : 'openai' }
    : undefined
  return {
    ...existing ?? {},
    displayName: input.displayName,
    api: input.api,
    baseURL: input.baseURL,
    apiKeyEnv: input.credentialRef,
    models: input.models.map(modelProfile),
    ...compat === undefined ? {} : { compat },
  }
}

function protectedProfile(id: string, profile: JsonRecord, credentialRef: string, baseURL: string): JsonRecord {
  const compat = profile.api === 'openai-completions'
    ? {
        ...isRecord(profile.compat) ? profile.compat : {},
        maxTokensField: 'max_tokens',
        supportsReasoningEffort: Array.isArray(profile.models)
          && profile.models.some(model => isRecord(model) && isRecord(model.reasoningEfforts)),
        thinkingFormat: isRecord(profile.compat) && typeof profile.compat.thinkingFormat === 'string'
          ? profile.compat.thinkingFormat
          : id === 'one-nexus' ? 'qwen' : 'openai',
      }
    : undefined
  return {
    ...profile,
    baseURL,
    apiKeyEnv: credentialRef,
    ...compat === undefined ? {} : { compat },
  }
}

function proxyCredentialRef(id: string): string {
  const normalized = id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  return `DSH_MODEL_PROXY_${normalized}_${randomBytes(4).toString('hex').toUpperCase()}`
}

async function readView(target: FleetNativeTarget): Promise<ProviderControlView> {
  const [described, registeredRaw, configurableRaw, catalogRaw] = await Promise.all([
    settings(target),
    rpc(target, 'llm/listProviders', {}),
    rpc(target, 'llm/listConfigurableProviders', {}),
    rpc(target, 'session/modelCatalog', {}),
  ])
  const registered = z.array(RegisteredProvider).parse(registeredRaw)
  const configurable = z.array(ConfigurableProvider).parse(configurableRaw)
  const catalog = Catalog.parse(catalogRaw)
  const namespace = described.namespaces.find(item => item.ns === 'llm-pi-ai')
  if (!namespace) throw new ProviderControlError(502, 'This deployment has no llm-pi-ai settings namespace')
  const active = new Set(registered.map(item => item.id))
  const directory = new Map(configurable.map(item => [item.provider, item]))
  const profiles = providerProfiles(namespace.value)
  const refs = [...new Set(Object.values(profiles).flatMap(profile =>
    typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv !== '' ? [profile.apiKeyEnv] : []))]
  let credentials: Record<string, z.infer<typeof CredentialInfo>> = {}
  let credentialError: string | undefined
  if (refs.length > 0) {
    try {
      credentials = z.record(z.string(), CredentialInfo).parse(await rpc(target, 'credentials/describe', { refs }))
    } catch (error) {
      credentialError = redactSensitive(error instanceof Error ? error.message : String(error))
    }
  }
  const providers = Object.entries(profiles).map(([id, profile]): ProviderView => {
    const directoryItem = directory.get(id)
    const credentialRef = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined
    return {
      id,
      displayName: typeof profile.displayName === 'string' ? profile.displayName : directoryItem?.displayName ?? id,
      ...typeof profile.api === 'string' ? { api: profile.api } : {},
      ...typeof profile.baseURL === 'string' ? { baseURL: profile.baseURL } : {},
      ...credentialRef === undefined ? {} : { credentialRef },
      ...credentialRef !== undefined && credentials[credentialRef] !== undefined ? { credential: credentials[credentialRef] } : {},
      models: modelViews(profile),
      active: active.has(id),
      configured: pathValue(namespace.value, ['providers', id]) !== undefined,
      removable: userProfile(namespace.user, id) !== undefined,
      ...directoryItem?.error === undefined ? {} : { error: redactSensitive(directoryItem.error) },
    }
  }).sort((left, right) => left.displayName.localeCompare(right.displayName))
  return {
    writable: described.writable,
    revision: namespace.revision,
    providers,
    catalog,
    ...credentialError === undefined ? {} : { credentialError },
  }
}

async function targetOf(fleet: Fleet, id: string): Promise<FleetNativeTarget> {
  try { return await fleet.managementTarget(id) }
  catch (error) {
    throw new ProviderControlError(404, redactSensitive(error instanceof Error ? error.message : String(error)))
  }
}

/** Read provider profiles, credential presence, and the routable model catalog for one deployment. */
export async function providerControl(fleet: Fleet, id: string): Promise<ProviderControlView> {
  return readView(await targetOf(fleet, id))
}

/** Create or replace one provider profile, optionally storing its write-only API key. */
export async function saveProvider(fleet: Fleet, deployment: string, provider: string, raw: unknown): Promise<ProviderControlView> {
  const input = ProviderInput.parse(raw)
  const target = await targetOf(fleet, deployment)
  const described = await settings(target)
  const namespace = described.namespaces.find(item => item.ns === 'llm-pi-ai')
  if (!namespace) throw new ProviderControlError(502, 'This deployment has no llm-pi-ai settings namespace')
  const profiles = providerProfiles(namespace.value)
  const profile = profileFor(input, profiles[provider])
  await rpc(target, 'settings/mutate', {
    ns: 'llm-pi-ai',
    ops: [{ op: 'set', path: ['providers', provider], value: profile }],
    expectedRevision: input.revision,
  })
  if (input.apiKey !== undefined) {
    await rpc(target, 'credentials/set', { ref: input.credentialRef, value: input.apiKey })
  }
  return readView(target)
}

/** Rotate one provider credential without reading or returning the secret. */
export async function setProviderCredential(fleet: Fleet, deployment: string, provider: string, raw: unknown): Promise<ProviderControlView> {
  const input = CredentialInput.parse(raw)
  const target = await targetOf(fleet, deployment)
  const view = await readView(target)
  const current = view.providers.find(item => item.id === provider)
  if (!current) throw new ProviderControlError(404, `Provider not found: ${provider}`)
  if (!current.credentialRef) throw new ProviderControlError(400, `Provider ${provider} has no credential reference`)
  await rpc(target, 'credentials/set', { ref: current.credentialRef, value: input.value })
  return readView(target)
}

/**
 * Move every provider profile in one deployment behind the protected loopback model proxy.
 * The new key is rolled back if either the credential write or configuration transition fails.
 */
export async function configureDeploymentModelProxy(fleet: Fleet, deployment: string): Promise<ProviderControlView> {
  const target = await targetOf(fleet, deployment)
  const proxy = await fleet.modelProxyStatus()
  if (proxy.status !== 'ready') {
    throw new ProviderControlError(409, `The protected model proxy is ${proxy.status}`)
  }
  const described = await settings(target)
  const namespace = described.namespaces.find(item => item.ns === 'llm-pi-ai')
  if (!namespace) throw new ProviderControlError(502, 'This deployment has no llm-pi-ai settings namespace')
  const profiles = providerProfiles(namespace.value)
  if (Object.keys(profiles).length === 0) {
    throw new ProviderControlError(409, 'This deployment has no provider profiles to move behind the model proxy')
  }

  const created = await fleet.createModelProxyKey(deployment)
  const credentialRef = proxyCredentialRef(deployment)
  let credentialWritten = false
  let settingsChanged = false
  let settingsRevision: number | undefined
  const oldRefs = [...new Set(Object.values(profiles).flatMap(profile =>
    typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv !== '' ? [profile.apiKeyEnv] : []))]
  try {
    await rpc(target, 'credentials/set', { ref: credentialRef, value: created.value })
    credentialWritten = true
    const mutated = await rpc(target, 'settings/mutate', {
      ns: 'llm-pi-ai',
      ops: Object.entries(profiles).map(([id, profile]) => ({
        op: 'set',
        path: ['providers', id],
        value: protectedProfile(id, profile, credentialRef, proxy.baseURL),
      })),
      expectedRevision: namespace.revision,
    })
    settingsChanged = true
    const mutation = z.object({ revision: z.number().int().nonnegative() }).parse(mutated)
    settingsRevision = mutation.revision
    const view = await readView(target)
    const missing = view.providers.filter(provider =>
      provider.baseURL !== proxy.baseURL || provider.credentialRef !== credentialRef)
    if (missing.length > 0) {
      throw new ProviderControlError(502, `Provider transition could not be verified: ${missing.map(item => item.id).join(', ')}`)
    }
    await fleet.finalizeModelProxyKey(deployment, created.value)
    for (const ref of oldRefs) {
      if (ref !== credentialRef) await rpc(target, 'credentials/unset', { ref }).catch(() => undefined)
    }
    return view
  } catch (error) {
    if (settingsChanged) {
      const revision = settingsRevision ?? (await readView(target).catch(() => undefined))?.revision
      if (revision !== undefined) await rpc(target, 'settings/mutate', {
        ns: 'llm-pi-ai',
        ops: Object.entries(profiles).map(([id, profile]) => ({
          op: 'set',
          path: ['providers', id],
          value: profile,
        })),
        expectedRevision: revision,
      }).catch(() => undefined)
    }
    if (credentialWritten) await rpc(target, 'credentials/unset', { ref: credentialRef }).catch(() => undefined)
    await fleet.revokeModelProxyKey(deployment, created.value).catch(() => undefined)
    throw error
  }
}

/** Remove this deployment's user-layer provider override; a composition base profile remains effective. */
export async function resetProvider(fleet: Fleet, deployment: string, provider: string, raw: unknown): Promise<ProviderControlView> {
  const input = ResetInput.parse(raw)
  const target = await targetOf(fleet, deployment)
  const described = await settings(target)
  const namespace = described.namespaces.find(item => item.ns === 'llm-pi-ai')
  if (!namespace) throw new ProviderControlError(502, 'This deployment has no llm-pi-ai settings namespace')
  if (userProfile(namespace.user, provider) === undefined) {
    throw new ProviderControlError(409, `Provider ${provider} has no user-layer override to reset`)
  }
  await rpc(target, 'settings/mutate', {
    ns: 'llm-pi-ai',
    ops: [{ op: 'unset', path: ['providers', provider] }],
    expectedRevision: input.revision,
  })
  return readView(target)
}
