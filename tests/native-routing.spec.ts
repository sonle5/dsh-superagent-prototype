import { expect, it } from 'vitest'
import type { FleetNativeTarget } from '../src/app/fleet.ts'
import {
  deploymentOwnedPath,
  hasDesktopWorkspaceBaseline,
  nativePeerApiUrl,
  nativePeerMuxUrl,
} from '../src/app/native-transport.ts'

const target = (overrides: Partial<FleetNativeTarget> & Pick<FleetNativeTarget, 'id' | 'remote'>): FleetNativeTarget => ({
  url: 'http://127.0.0.1:3082',
  nativeUrl: 'http://127.0.0.1:3082',
  repository: 'onenexus-team/inference-support-loop',
  profile: 'superagent-inference-support-loop',
  stateDir: '/tmp/superagent',
  workspace: '/tmp/worktree',
  token: 'token',
  ...overrides,
})

it('uses the dedicated gateway native endpoint for a remote Remote mux', () => {
  expect(nativePeerMuxUrl(target({
    id: 'inference-support-loop',
    remote: true,
    url: 'https://gateway.example/gateway/api/deployment/inference-support-loop',
    nativeUrl: 'https://gateway.example/gateway/native/inference-support-loop',
  }))).toBe('wss://gateway.example/gateway/native/inference-support-loop/remote.mux')
})

it('uses the local native mux below the peer origin', () => {
  expect(nativePeerMuxUrl(target({
    id: 'sglang',
    remote: false,
    url: 'http://127.0.0.1:3083/',
    nativeUrl: 'http://127.0.0.1:3083/',
  }))).toBe('ws://127.0.0.1:3083/orchestrator/native/remote.mux')
})

it('keeps the RPC suffix on local and remote native API requests', () => {
  expect(nativePeerApiUrl(target({
    id: 'sglang',
    remote: false,
    url: 'http://127.0.0.1:3083/',
  }), '/api/session/list').href).toBe('http://127.0.0.1:3083/orchestrator/native/api/session/list')

  expect(nativePeerApiUrl(target({
    id: 'inference-support-loop',
    remote: true,
    url: 'https://gateway.example/gateway/api/deployment/inference-support-loop',
    nativeUrl: 'https://gateway.example/gateway/native/inference-support-loop',
  }), '/api/session/list').href)
    .toBe('https://gateway.example/gateway/native/inference-support-loop/api/session/list')
})

it('requires the Desktop fallback baseline before publishing a partial workspace catalog', () => {
  const desktop = target({ id: 'desktop.local', remote: false, repository: '' })
  const sglang = target({ id: 'sglang', remote: false })
  expect(hasDesktopWorkspaceBaseline([desktop, sglang], new Set(['sglang']))).toBe(false)
  expect(hasDesktopWorkspaceBaseline([desktop, sglang], new Set(['sglang', 'desktop.local']))).toBe(true)
  expect(hasDesktopWorkspaceBaseline([sglang, desktop], new Set(['sglang', 'desktop.local']))).toBe(true)
})

it('does not treat an empty remote state path as owning every Desktop path', () => {
  const desktop = target({ id: 'desktop.local', remote: false, repository: '', stateDir: '/Users/me/.dsh' })
  const cloud = target({ id: 'inference-support-loop', remote: true, stateDir: '' })
  expect(deploymentOwnedPath(desktop, '/Users/me/.dsh/workspace', [desktop, cloud])).toBe(false)

  const local = target({ id: 'sglang', remote: false, stateDir: '/Users/me/.dsh/state/superagent-sglang' })
  expect(deploymentOwnedPath(desktop, '/Users/me/.dsh/state/superagent-sglang/worktree', [desktop, local])).toBe(true)
})
