import { beforeEach, expect, it, vi } from 'vitest'
import type { Fleet } from '../src/app/fleet.ts'

const native = vi.hoisted(() => {
  class NativePeerRpcError extends Error {
    constructor(readonly code: string, message: string, readonly details: unknown = {}) {
      super(message)
    }
  }
  return { NativePeerRpcError, nativePeerRpc: vi.fn() }
})
vi.mock('../src/app/native-transport.ts', () => native)

import {
  providerControl, resetProvider, saveProvider, setProviderCredential,
} from '../src/app/providers.ts'

const target = {
  id: 'inference-support-loop',
  remote: true,
  url: 'https://superagent.example/deployments/inference-support-loop',
  nativeUrl: 'https://superagent.example/deployments/inference-support-loop',
  repository: 'onenexus-team/inference-support-loop',
  profile: 'superagent-inference-support-loop',
  stateDir: '/srv/deployments/inference-support-loop',
  workspace: '/srv/worktrees/inference-support-loop',
  token: 'native-test-token',
}
const managementTarget = vi.fn(async () => target)
const fleet = { managementTarget } as unknown as Fleet
const catalog = {
  default: { provider: 'one-nexus', model: 'glm-5.3-sontinh', reasoningEffort: 'max' },
  routableProviders: ['one-nexus'],
  failures: [],
  groups: [{ id: 'one-nexus', name: 'One Nexus', models: [{ id: 'glm-5.3-sontinh', name: 'GLM 5.3' }] }],
}
const profile = {
  displayName: 'One Nexus',
  api: 'openai-completions',
  baseURL: 'https://onenexus.example/v1',
  apiKeyEnv: 'ONENEXUS_API_KEY',
  models: [{ id: 'glm-5.3-sontinh', name: 'GLM 5.3', contextWindow: 330000, maxTokens: 65000,
    input: ['text'], reasoningEfforts: { high: 'high', max: 'max' } }],
}
let described: Record<string, unknown>

beforeEach(() => {
  native.nativePeerRpc.mockReset()
  managementTarget.mockClear()
  described = {
    writable: true,
    namespaces: [{ ns: 'llm-pi-ai', value: { providers: { 'one-nexus': structuredClone(profile) } },
      user: { providers: { 'one-nexus': structuredClone(profile) } }, revision: 4 }],
  }
  native.nativePeerRpc.mockImplementation(async (_target, method, args) => {
    if (method === 'settings/describe') return structuredClone(described)
    if (method === 'llm/listProviders') return [{ id: 'one-nexus', name: 'One Nexus' }]
    if (method === 'llm/listConfigurableProviders') return [{
      provider: 'one-nexus', displayName: 'One Nexus', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'one-nexus'],
    }]
    if (method === 'session/modelCatalog') return structuredClone(catalog)
    if (method === 'credentials/describe') {
      return Object.fromEntries((args.refs as string[]).map(ref => [ref, { configured: true, source: 'user', writable: true }]))
    }
    if (method === 'settings/mutate') {
      const namespaces = described.namespaces as Array<{ revision: number; value: Record<string, unknown>; user: Record<string, unknown> }>
      const namespace = namespaces[0]!
      if (args.expectedRevision !== namespace.revision) {
        throw new native.NativePeerRpcError('settings/conflict', 'Settings changed. Reload before saving.')
      }
      const ops = args.ops as Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>
      for (const op of ops) {
        if (op.op === 'set') {
          const providers = ((namespace.value.providers ??= {}) as Record<string, unknown>)
          providers[op.path[1]!] = op.value
        } else {
          const providers = namespace.value.providers as Record<string, unknown>
          delete providers[op.path[1]!]
        }
      }
      namespace.revision++
      return { revision: namespace.revision }
    }
    if (method === 'credentials/set') return {}
    throw new Error(`Unexpected RPC ${method}`)
  })
})

it('reads one deployment provider view with credential presence but no secret material', async () => {
  const view = await providerControl(fleet, 'inference-support-loop')
  expect(managementTarget).toHaveBeenCalledWith('inference-support-loop')
  expect(view).toMatchObject({
    writable: true,
    revision: 4,
    providers: [{
      id: 'one-nexus',
      displayName: 'One Nexus',
      credentialRef: 'ONENEXUS_API_KEY',
      credential: { configured: true, source: 'user', writable: true },
      models: [{ id: 'glm-5.3-sontinh', contextWindow: 330000, maxTokens: 65000, reasoning: true, image: false }],
      active: true,
      configured: true,
      removable: true,
    }],
  })
  expect(JSON.stringify(view)).not.toMatch(/apiKey(?:[^E]|$)/)
})

it('creates or replaces a provider and stores its key only through the credential RPC', async () => {
  const view = await saveProvider(fleet, 'inference-support-loop', 'cpa', {
    displayName: 'Claude via CPA',
    api: 'openai-completions',
    baseURL: 'https://cpa.example/v1',
    credentialRef: 'CPA_API_KEY',
    apiKey: 'sk-private-provider-key',
    models: [{ id: 'claude-opus-5-5(auto)', name: 'Claude Opus 5.5', maxTokens: 65000, reasoning: true, image: true }],
    revision: 4,
  })
  const mutate = native.nativePeerRpc.mock.calls.find(([, method]) => method === 'settings/mutate')
  const set = native.nativePeerRpc.mock.calls.find(([, method]) => method === 'credentials/set')
  expect(mutate?.[2]).toMatchObject({
    ns: 'llm-pi-ai',
    expectedRevision: 4,
    ops: [{ op: 'set', path: ['providers', 'cpa'], value: {
      displayName: 'Claude via CPA',
      apiKeyEnv: 'CPA_API_KEY',
      compat: { maxTokensField: 'max_tokens', supportsReasoningEffort: true, thinkingFormat: 'openai' },
    } }],
  })
  expect(JSON.stringify(mutate?.[2])).not.toContain('sk-private-provider-key')
  expect(set?.[2]).toEqual({ ref: 'CPA_API_KEY', value: 'sk-private-provider-key' })
  expect(JSON.stringify(view)).not.toContain('sk-private-provider-key')
})

it('maps DSH revision conflicts to an HTTP conflict without mutating credentials', async () => {
  await expect(saveProvider(fleet, 'inference-support-loop', 'one-nexus', {
    displayName: 'Changed',
    api: 'openai-completions',
    baseURL: 'https://onenexus.example/v1',
    credentialRef: 'ONENEXUS_API_KEY',
    apiKey: 'sk-must-not-be-stored',
    models: [{ id: 'glm-5.3-sontinh', name: 'GLM 5.3', reasoning: true, image: false }],
    revision: 3,
  })).rejects.toMatchObject({ status: 409 })
  expect(native.nativePeerRpc.mock.calls.some(([, method]) => method === 'credentials/set')).toBe(false)
})

it('rotates the existing credential reference and resets only a user-layer override', async () => {
  const rotated = await setProviderCredential(fleet, 'inference-support-loop', 'one-nexus', { value: 'sk-rotated-key' })
  expect(native.nativePeerRpc).toHaveBeenCalledWith(target, 'credentials/set',
    { ref: 'ONENEXUS_API_KEY', value: 'sk-rotated-key' })
  expect(JSON.stringify(rotated)).not.toContain('sk-rotated-key')

  await resetProvider(fleet, 'inference-support-loop', 'one-nexus', { revision: 4 })
  expect(native.nativePeerRpc).toHaveBeenCalledWith(target, 'settings/mutate', {
    ns: 'llm-pi-ai',
    ops: [{ op: 'unset', path: ['providers', 'one-nexus'] }],
    expectedRevision: 4,
  })
})
