import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, installModelSelection, type Agent, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { applyRoleModel } from '../src/app/role-models.ts'
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())); vi.restoreAllMocks() })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx); await ctx.plugin(SystemPrompt)
  const resolve = vi.fn(async value => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const session = Session.create(SessionId('role-model'))
  const agent = { ctx, session } as Agent
  let picked: ModelSelection | undefined
  const host: ModelSelectionRef = {
    get current() { return picked ?? session.requestHeader()?.config ?? { provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') } },
    set current(value) { picked = value },
    assembled: undefined,
  }
  installModelSelection(ctx, host)
  ctx.reflect.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') }),
  })
  const request = () => agentEvents(ctx, agent).waterfall('agent/request', { turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'seed', model: 'seed' }))
  const record = (selection: ModelSelection) => { const event = session.append('request/header', { header: { config: selection }, reason: 'initial' }); ctx.emit('session/event', session, event) }
  return { ctx, agent, host, resolve, flush, request, record }
}
it('keeps prompt variables and initial routing on the role model without saving the host default', async () => {
  const { ctx, agent, request, record, flush } = await fixture()
  await applyRoleModel(ctx, agent, { provider: 'worker-provider', model: 'worker-model' })
  expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'worker-provider', model: 'worker-model' })
  const selected = await request()
  expect(selected).toEqual({ provider: 'worker-provider', model: 'worker-model' })
  expect(agent.session.snapshotEvents().some(event => event.type === 'model/selection')).toBe(true)
  expect(flush).toHaveBeenCalledOnce()
  record(selected)
  // A retry of the same assembled step keeps the same model even after the header is persisted.
  expect(await request()).toEqual(selected)
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(selected)
})
it('lets a later explicit selection win without changing the in-flight assembled step', async () => {
  const { ctx, agent, host, request } = await fixture()
  await applyRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  await ctx.systemPrompt.assemble()
  const manual = { provider: 'manual', model: 'two', reasoningEffort: ReasoningEffortId('low') }
  Object.defineProperty(host, 'current', { value: manual, configurable: true })
  const event = agent.session.append('model/selection', manual); ctx.emit('session/event', agent.session, event)
  expect(await request()).toEqual({ provider: 'worker', model: 'one' })
  await ctx.systemPrompt.assemble()
  expect(await request()).toEqual(manual)
})
it.each(['request header', 'selection event'])('applies the configured model to a resumed Session with an existing %s', async kind => {
  const { ctx, agent, resolve } = await fixture()
  const existing = { provider: 'existing', model: 'keep' }
  if (kind === 'request header') agent.session.append('request/header', { header: { config: existing }, reason: 'initial' })
  else {
    const event = agent.session.append('model/selection', existing)
    ctx.emit('session/event', agent.session, event)
  }
  await applyRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).toHaveBeenCalledOnce()
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection').at(-1)?.data).toEqual({
    provider: 'worker', model: 'new' })
})
it('does not append another selection when the configured route is already current', async () => {
  const { ctx, agent } = await fixture()
  const model = { provider: 'worker', model: 'one' }
  await applyRoleModel(ctx, agent, model)
  await applyRoleModel(ctx, agent, model)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
})
it('restores the deployment default when the role override is cleared', async () => {
  const { ctx, agent } = await fixture()
  await applyRoleModel(ctx, agent, { provider: 'worker', model: 'one' })
  await applyRoleModel(ctx, agent, null)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection').at(-1)?.data).toEqual({
    provider: 'host', model: 'default', reasoningEffort: ReasoningEffortId('high') })
})
it('inherits the host when unset and fails unavailable routes before recording a selection', async () => {
  const { ctx, agent, resolve, request } = await fixture()
  await applyRoleModel(ctx, agent, null)
  await ctx.systemPrompt.assemble()
  expect(await request()).toMatchObject({ provider: 'host', model: 'default' })
  resolve.mockRejectedValueOnce(new Error('unknown provider'))
  const before = agent.session.snapshotEvents().filter(event => event.type === 'model/selection').length
  await expect(applyRoleModel(ctx, agent, { provider: 'unknown', model: 'x' })).rejects.toThrow('unknown provider')
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(before)
})

it('uses the Agent model selector required by DSH 0.2.2 before step preparation', async () => {
  const ctx = new Context(); contexts.push(ctx)
  const resolve = vi.fn(async value => value)
  const flush = vi.fn(async () => {})
  ctx.reflect.provide('llm', { resolveCallConfig: resolve })
  ctx.reflect.provide('sessionPersistence', { flush })
  const select = vi.fn()
  const agent = { ctx, session: {}, model: { select } } as unknown as Agent
  await applyRoleModel(ctx, agent, { provider: 'worker', model: 'new' })
  expect(resolve).toHaveBeenCalledWith({ provider: 'worker', model: 'new' })
  expect(select).toHaveBeenCalledWith({ provider: 'worker', model: 'new' })
  expect(flush).toHaveBeenCalledOnce()
})
