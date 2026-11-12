/** Browser plugin entry point registering the sidebar icon, main management panel, and Plugin Manager config view. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { App } from './app.tsx'
import { PluginConfig } from './deployment.tsx'
import { en, zh } from './locales.ts'
import { installDesktopNativeTransport, isDesktopShell, reconnectDesktopConnection } from './native-transport.ts'
import type { T } from './text.ts'

type ClientContext = Context
const NS = 'dshSuperagent'
const PANEL_ID = 'dsh-superagent' as MainPanelId
const ENTRY = 'dsh-superagent'

function HammerIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3.5h9l3.5 1.75v2.5L15 9.5H6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" /><path d="M10 9.5v10.25a1.75 1.75 0 0 0 3.5 0V9.5" /><path d="M10 15.5h3.5" />
  </svg>
}

function Mounted({ ctx, t }: { ctx: ClientContext; t: T }) {
  return <App t={t} openSession={id => ctx.uiWorkspace.openSession(id as never)} />
}

export const inject = ['slots', 'locale', 'connection', 'uiWorkspace']
/** Registers the panel, sidebar icon, and Plugin Manager config view; `configForms` is optional (without it, machine settings are read-only). */
export function apply(ctx: ClientContext): void {
  if (isDesktopShell()) {
    ctx.effect(() => {
      const restore = installDesktopNativeTransport()
      const connection = ctx.get('connection') as unknown as ConnectionHandle
      const reconnect = reconnectDesktopConnection(connection)
      return () => {
        reconnect()
        restore()
      }
    }, 'dsh-superagent: native deployment transport')
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    (props: { t: T }) => <Mounted ctx={ctx} t={props.t} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => t('panel'), locale: NS }, HammerIcon))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: `${ENTRY}#${ENTRY}`, locale: NS },
    (props: PluginConfigViewProps & { t: T }) => <PluginConfig t={props.t} view={props.view} form={props.form} />))
}
