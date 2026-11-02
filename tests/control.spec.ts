import { expect, it, vi } from 'vitest'
import { Config } from '../src/deployment.ts'
import { apply } from '../src/index.ts'

const registered = vi.hoisted(() => [] as { stateDir: string; disposed: boolean }[])
vi.mock('../src/app/http.ts', () => ({
  registerControlHttp: (_ctx: unknown, stateDir: string) => {
    const record = { stateDir, disposed: false }
    registered.push(record)
    return () => { record.disposed = true }
  },
}))

it('mounts only the fleet controller for the configured control state directory', async () => {
  const disposers: (() => void)[] = []
  const ctx = {
    effect: vi.fn((register: () => (() => void)) => { disposers.push(register()) }),
    logger: { info: vi.fn() },
  }
  await apply(ctx as never, Config({ mode: 'control', stateDir: '/srv/superagent-control' }))
  expect(registered).toEqual([{ stateDir: '/srv/superagent-control', disposed: false }])
  disposers[0]!()
  expect(registered[0]!.disposed).toBe(true)
})
