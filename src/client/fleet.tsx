/** Native fleet overview: aggregate health, work, Triggers, workspaces, logs, and lifecycle actions per deployment. */
import { usePoll, type FleetView } from './api.ts'
import { Button, Dot, Icon, Tag, type DotState, type TagTone } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Hint, LoadState, Section, When } from './widgets.tsx'

type Action = 'start' | 'stop' | 'restart'
type Deployment = FleetView['deployments'][number]

const dot = (status: Deployment['status']): DotState => status === 'ready' ? 'done'
  : status === 'starting' ? 'ongoing' : status === 'error' || status === 'unreachable' ? 'error'
  : status === 'stopped' ? 'idle' : 'warning'
const tone = (status: Deployment['status']): TagTone => status === 'ready' ? 'success'
  : status === 'starting' ? 'info' : status === 'error' || status === 'unreachable' ? 'danger'
  : status === 'stopped' ? 'quiet' : 'warning'

function Controls({ deployment, run, busy }: { deployment: Deployment; run: (id: string, action: Action) => Promise<unknown>
  busy: boolean }) {
  const { t } = usePanel()
  if (!deployment.canControl) return null
  const start = <Button variant="outline" size="sm" icon={<Icon name="play" size={14} />} disabled={busy}
    onClick={() => { void run(deployment.id, 'start') }}>{t('fleetStart')}</Button>
  if (deployment.status === 'stopped' || deployment.status === 'unreachable') return start
  return <>
    <Button variant="outline" size="sm" icon={<Icon name="stop" size={14} />} disabled={busy}
      onClick={() => { void run(deployment.id, 'stop') }}>{t('fleetStop')}</Button>
    <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={busy}
      onClick={() => { void run(deployment.id, 'restart') }}>{t('fleetRestart')}</Button>
  </>
}

function DeploymentCard({ deployment, run, busy }: { deployment: Deployment; run: (id: string, action: Action) => Promise<unknown>
  busy: boolean }) {
  const { t } = usePanel()
  const health = deployment.health.filter(item => item.state !== 'ready')
  return <article className="dt-card dt-fleet-card" data-status={deployment.status}>
    <div className="dt-card-head">
      <Dot state={dot(deployment.status)} label={t(`fleetStatus.${deployment.status}`)} />
      <div className="dt-row-main">
        <div className="dt-row-title"><span className="dt-card-title">{deployment.name}</span></div>
        <div className="dt-row-meta">
          <span className="dt-mono">{deployment.repository || deployment.stateDir}</span>
          <span>{deployment.origin === 'desktop' ? t('fleetEmbedded') : `${t('fleetProfile')} ${deployment.profile}`}</span>
        </div>
      </div>
      <Tag tone={tone(deployment.status)}>{t(`fleetStatus.${deployment.status}`)}</Tag>
    </div>
    <p className="dt-fleet-detail">{deployment.detail}</p>
    <div className="dt-stats">
      <span className="dt-stat"><span className="dt-stat-label">{t('executingLabel')}</span><span className="dt-stat-value">
        {deployment.load.running} / {deployment.load.maxWorkers}</span></span>
      <span className="dt-stat"><span className="dt-stat-label">{t('queuedLabel')}</span><span className="dt-stat-value">
        {deployment.load.queued}</span></span>
      <span className="dt-stat"><span className="dt-stat-label">{t('fleetOpenTickets')}</span><span className="dt-stat-value">
        {deployment.tickets.open}</span></span>
      <span className="dt-stat"><span className="dt-stat-label">{t('fleetPendingTriggers')}</span><span className="dt-stat-value">
        {deployment.triggers.pending}</span></span>
    </div>
    {health.length > 0 && <ul className="dt-plain-list dt-fleet-health">{health.map(item => <li key={item.name}>
      <span>{item.name}</span><span className="dt-error-text">{item.detail}</span>
    </li>)}</ul>}
    <div className="dt-row-buttons">
      <Controls deployment={deployment} run={run} busy={busy} />
    </div>
    <details className="dt-fleet-details">
      <summary>{t('fleetDetails')}</summary>
      <div className="dt-fleet-detail-grid">
        <section>
          <h3>{t('fleetRecentTickets')}</h3>
          {deployment.tickets.recent.length ? <ul className="dt-plain-list">{deployment.tickets.recent.map(ticket => <li key={ticket.id}>
            <span className="dt-line-text">{ticket.title}</span><span className="dt-row-meta">{ticket.stage}</span>
          </li>)}</ul> : <Hint>{t('none')}</Hint>}
        </section>
        <section>
          <h3>{t('fleetRecentTriggers')}</h3>
          {deployment.triggers.recent.length ? <ul className="dt-plain-list">{deployment.triggers.recent.map(thread => <li key={thread.key}>
            <span className="dt-line-text">{thread.title}</span><span className="dt-row-meta">{thread.source} · <When at={thread.lastAt} /></span>
          </li>)}</ul> : <Hint>{t('none')}</Hint>}
        </section>
        <section>
          <h3>{t('fleetWorkspace')}</h3>
          <dl className="dt-kv">
            <dt>{t('fleetStateDir')}</dt><dd className="dt-mono">{deployment.stateDir}</dd>
            <dt>{t('fleetWorkspace')}</dt><dd className="dt-mono">{deployment.workspace}</dd>
            <dt>{t('fleetEndpoint')}</dt><dd className="dt-mono">{deployment.url}</dd>
          </dl>
        </section>
        {deployment.log && <section className="dt-fleet-log">
          <h3>{t('fleetLog')}</h3>
          <p className="dt-hint dt-mono">{deployment.log.path}</p>
          <pre className="dt-pre">{deployment.log.tail || t('none')}</pre>
        </section>}
      </div>
    </details>
  </article>
}

export function FleetPage() {
  const { t, call, notify } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET fleet'), [], 5_000)
  const act = useAction(async (id: string, action: Action) => {
    const result = action === 'start' ? await call('POST fleet/:id/start', { id })
      : action === 'stop' ? await call('POST fleet/:id/stop', { id })
      : await call('POST fleet/:id/restart', { id })
    notify(result.output || t(`fleetAction.${action}`))
  }, { reload })
  if (!data) return <LoadState error={error} loading />
  return <>
    {error && <LoadState error={error} loading={false} />}
    <Section title={t('fleetTitle')} count={data.deployments.length} hint={t('fleetIntro')}>
      {data.error && <p className="dt-error">{data.error}</p>}
      <div className="dt-fleet-grid">
        {data.deployments.map(deployment => <DeploymentCard key={deployment.id} deployment={deployment} run={act.run} busy={act.busy} />)}
      </div>
      <Hint>{data.configured ? t('fleetRegistry', { path: data.registryPath })
        : t('fleetRegistryMissing', { path: data.registryPath })}</Hint>
    </Section>
  </>
}
