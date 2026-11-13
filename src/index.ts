/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'
import { registerGateway } from './app/gateway.ts'
import { registerControlHttp } from './app/http.ts'
import { registerNativeTransport } from './app/native-transport.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills',
  'webServer', 'connection', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  if (config.mode === 'control') {
    ctx.effect(() => {
      const disposeHttp = registerControlHttp(ctx, config.stateDir)
      const disposeNative = registerNativeTransport(ctx, config.stateDir, 'control')
      return () => {
        disposeNative()
        disposeHttp()
      }
    })
    ctx.logger.info('dsh-superagent control ready; the Superagent sidebar opens the repository-neutral fleet')
    return
  }
  if (config.mode === 'gateway') {
    ctx.effect(() => registerGateway(ctx, config.stateDir))
    ctx.logger.info('dsh-superagent gateway ready; signed-in Fleet clients can use /gateway/api')
    return
  }
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  // Desktop requests settings as soon as the Host reports ready. Keep native routing available while the repository
  // runtime performs its own longer startup checks.
  ctx.effect(() => registerNativeTransport(ctx, machine.stateDir, 'repository'))
  const runtime = new Runtime(ctx, machine, restart)
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
