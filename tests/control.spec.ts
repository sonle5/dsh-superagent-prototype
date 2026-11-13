import { beforeEach, expect, it, vi } from 'vitest'
import { Config } from '../src/deployment.ts'
import { apply } from '../src/index.ts'

const registered = vi.hoisted(() => [] as { stateDir: string; disposed: boolean }[])
const nativeRegistered = vi.hoisted(() => [] as { stateDir: string; role: string; disposed: boolean }[])
const gatewayRegistered = vi.hoisted(() => [] as { stateDir: string; disposed: boolean }[])
const runtimeLifecycle = vi.hoisted(() => ({
  starts: 0,
  release: () => {},
}))
vi.mock('../src/app/http.ts', () => ({
  registerControlHttp: (_ctx: unknown, stateDir: string) => {
    const record = { stateDir, disposed: false }
    registered.push(record)
    return () => { record.disposed = true }
  },
}))
vi.mock('../src/app/native-transport.ts', () => ({
  registerNativeTransport: (_ctx: unknown, stateDir: string, role: string) => {
    const record = { stateDir, role, disposed: false }
    nativeRegistered.push(record)
    return () => { record.disposed = true }
  },
}))
vi.mock('../src/app/gateway.ts', () => ({
  registerGateway: (_ctx: unknown, stateDir: string) => {
    const record = { stateDir, disposed: false }
    gatewayRegistered.push(record)
    return () => { record.disposed = true }
  },
}))
vi.mock('../src/app/runtime.ts', () => ({
  Runtime: class {
    readonly ready = new Promise<void>(resolve => { runtimeLifecycle.release = resolve })

    constructor() {
      runtimeLifecycle.starts++
    }

    async stop(): Promise<void> {}
    configured(): boolean { return true }
  },
}))

beforeEach(() => {
  registered.length = 0
  nativeRegistered.length = 0
  gatewayRegistered.length = 0
  runtimeLifecycle.starts = 0
})

it('mounts only the fleet controller for the configured control state directory', async () => {
  const disposers: (() => void)[] = []
  const ctx = {
    effect: vi.fn((register: () => (() => void)) => { disposers.push(register()) }),
    logger: { info: vi.fn() },
  }
  await apply(ctx as never, Config({ mode: 'control', stateDir: '/srv/superagent-control' }))
  expect(registered).toEqual([{ stateDir: '/srv/superagent-control', disposed: false }])
  expect(nativeRegistered).toEqual([{ stateDir: '/srv/superagent-control', role: 'control', disposed: false }])
  disposers[0]!()
  expect(registered[0]!.disposed).toBe(true)
  expect(nativeRegistered[0]!.disposed).toBe(true)
})

it('mounts only the public gateway for the configured gateway state directory', async () => {
  const disposers: (() => void)[] = []
  const ctx = {
    effect: vi.fn((register: () => (() => void)) => { disposers.push(register()) }),
    logger: { info: vi.fn() },
  }
  await apply(ctx as never, Config({ mode: 'gateway', stateDir: '/srv/superagent-gateway' }))
  expect(gatewayRegistered).toEqual([{ stateDir: '/srv/superagent-gateway', disposed: false }])
  expect(registered).toEqual([])
  expect(nativeRegistered).toEqual([])
  disposers[0]!()
  expect(gatewayRegistered[0]!.disposed).toBe(true)
})

it('routes native requests while the repository runtime is still starting', async () => {
  const ctx = {
    effect: vi.fn((register: () => (() => void)) => register()),
    get: vi.fn(),
    inject: vi.fn(),
    fiber: { restart: vi.fn() },
    logger: { info: vi.fn(), error: vi.fn() },
  }
  const ready = apply(ctx as never, Config({ mode: 'repository', stateDir: '/srv/superagent' }))

  expect(runtimeLifecycle.starts).toBe(1)
  expect(nativeRegistered).toEqual([{ stateDir: '/srv/superagent', role: 'repository', disposed: false }])

  runtimeLifecycle.release()
  await ready
})
