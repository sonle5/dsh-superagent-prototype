/** Resolves and applies per-role models to managed Sessions without changing the global DSH default. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { RoleModel } from '../policy.ts'

interface RoleSelection { selected?: ModelSelection; initial: boolean; assembled?: ModelSelection }
interface AgentModel {
  select(selection: Readonly<ModelSelection>): void
}
type ModernAgent = Agent & { readonly model?: AgentModel }
const selections = new WeakMap<Agent, RoleSelection>()

/** Resolve a configured route through the live provider; catalog membership is not a restriction. */
export async function resolveRoleModel(ctx: Context, model: RoleModel): Promise<ModelSelection> {
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) })
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}

const sameSelection = (left: ModelSelection, right: ModelSelection): boolean =>
  left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort

/** Apply a role model to the Session's next request, including an existing Session whose prior route is now stale. */
export async function applyRoleModel(ctx: Context, agent: Agent, model: RoleModel | null): Promise<void> {
  const selected = model ? await resolveRoleModel(ctx, model) : inheritedModel(ctx)
  // DSH 0.2.2 moved model selection onto the Agent and freezes the step route before
  // the agent/request waterfall. Appending only the event leaves that route at the
  // deployment default, and trying to replace it later is rejected.
  const modern = (agent as ModernAgent).model
  if (modern) {
    modern.select(selected)
    await ctx.sessionPersistence.flush()
    return
  }
  const state = selectionState(ctx, agent)
  if (state.selected && sameSelection(state.selected, selected)) return
  state.selected = selected
  state.initial = true
  agent.session.append('model/selection', selected)
  await ctx.sessionPersistence.flush()
}

/** Read the deployment's current DSH default when a role override is cleared. */
function inheritedModel(ctx: Context): ModelSelection {
  const defaults = ctx.get('agentDefaultModel') as { currentSelection(): ModelSelection } | undefined
  if (!defaults) throw new Error('the deployment default model is unavailable')
  return defaults.currentSelection()
}

/** Keep one role-model router per Agent so later settings changes replace its next route without stacking listeners. */
function selectionState(ctx: Context, agent: Agent): RoleSelection {
  const existing = selections.get(agent)
  if (existing) return existing
  const state: RoleSelection = { initial: true }
  selections.set(agent, state)
  agent.ctx.effect(() => {
    const disposers = [
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selected = state.initial ? state.selected : undefined
        const result = await next()
        state.assembled = selected
        return selected ? { ...result, variables: { ...result.variables, provider: selected.provider, model: selected.model } } : result
      }, { prepend: true }),
      agent.ctx.on('agent/request', async (_payload, next) => {
        const result = await next()
        if (!state.assembled) return result
        const { reasoningEffort: _inherited, ...rest } = result
        return { ...rest, ...state.assembled }
      }, { prepend: true }),
      ctx.on('session/event', (session, event) => {
        if (session !== agent.session || event.type !== 'request/header' && event.type !== 'model/selection') return
        const config = event.type === 'request/header' ? event.data.header.config : event.data
        const selected = { provider: config.provider, model: config.model,
          ...(config.reasoningEffort ? { reasoningEffort: ReasoningEffortId(config.reasoningEffort) } : {}) }
        if (event.type === 'model/selection' && state.selected && sameSelection(selected, state.selected)) return
        state.selected = selected
        state.initial = false
      }),
    ]
    return () => disposers.forEach(dispose => dispose())
  })
  return state
}
