/** Native fleet overview: aggregate health, work, Triggers, workspaces, logs, and lifecycle actions per deployment. */
import { useState, type FormEvent } from 'react'
import { usePoll, type FleetView } from './api.ts'
import { Button, Dot, Icon, Tag, type DotState, type TagTone } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Hint, LoadState, Section, When } from './widgets.tsx'

type Action = 'start' | 'stop' | 'restart'
type Deployment = FleetView['deployments'][number]
type DeviceView = {
  device_code: string
  user_code: string
  verification_uri: string
}

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

function CloudGateway({ reload, deployments, selected }: {
  reload: () => Promise<void>
  deployments: Deployment[]
  selected?: string
}) {
  const { t, call, notify } = usePanel()
  const gateway = usePoll(() => call('GET gateway/status'), [], 15_000)
  const [device, setDevice] = useState<DeviceView>()
  const [id, setId] = useState('')
  const [repository, setRepository] = useState('')
  const [credentialId, setCredentialId] = useState('')
  const [githubToken, setGithubToken] = useState('')
  const remote = deployments.filter(deployment => deployment.remote)
  const activeCredentialId = credentialId || selected && remote.some(deployment => deployment.id === selected) ? selected : remote[0]?.id
  const start = useAction(async () => setDevice(await call('POST gateway/device')))
  const complete = useAction(async () => {
    const current = device
    if (current === undefined) return
    await call('POST gateway/session', { body: { device_code: current.device_code } })
    setDevice(undefined)
    await reload()
    await gateway.reload()
  })
  const person = useAction(async () => {
    const result = await call('POST gateway/person')
    notify(result.created ? t('gatewayPersonCreated') : t('gatewayPersonReady'))
    await gateway.reload()
  })
  const deployment = useAction(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const result = await call('POST gateway/deployment', { body: { id, repository } })
    notify(t('gatewayDeploymentCreated', { repository: result.deployment.repository }))
    setId('')
    setRepository('')
    await reload()
    await gateway.reload()
  })
  const credentials = useAction(async () => {
    if (activeCredentialId === undefined) return
    await call('POST gateway/deployment/:id/credentials', {
      id: activeCredentialId,
      body: { githubToken },
    })
    setGithubToken('')
    notify(t('gatewayCredentialsSaved'))
    await reload()
  })
  const status = gateway.data
  return <article className="dt-card dt-fleet-card">
    <div className="dt-card-head">
      <div className="dt-row-main">
        <div className="dt-row-title"><span className="dt-card-title">{t('gatewayTitle')}</span></div>
        <div className="dt-row-meta">
          {status?.url && <span className="dt-mono">{status.url}</span>}
          {status?.login && <span>{t('gatewaySignedIn', { login: status.login, organization: status.organization ?? '' })}</span>}
        </div>
      </div>
      <Tag tone={status?.login ? 'success' : 'quiet'}>{status?.login ? status.login : t('gatewaySignedOut')}</Tag>
    </div>
    <p className="dt-fleet-detail">{t('gatewayIntro')}</p>
    {status?.error && <p className="dt-error">{status.error}</p>}
    {!status?.configured && <Hint>{t('gatewayNotConfigured')}</Hint>}
    {status?.configured && !status.login && <div className="dt-row-buttons">
      <Button variant="outline" size="sm" icon={<Icon name="play" size={14} />} disabled={start.busy}
        onClick={() => { void start.run() }}>{t('gatewaySignIn')}</Button>
    </div>}
    {device && <div className="dt-fleet-detail-grid">
      <section>
        <h3>{t('gatewayUserCode')}</h3>
        <p className="dt-fleet-detail"><strong>{device.user_code}</strong></p>
        <a className="dt-inline-link" href={device.verification_uri} target="_blank" rel="noopener noreferrer">
          {device.verification_uri}</a>
        <div className="dt-row-buttons">
          <Button variant="outline" size="sm" disabled={complete.busy}
            onClick={() => { void complete.run() }}>{t('gatewayCompleteSignIn')}</Button>
        </div>
      </section>
    </div>}
    {status?.login && status.person === false && <div className="dt-field">
      <span className="dt-field-head">{t('gatewayPerson')}</span>
      <Button variant="outline" size="sm" disabled={person.busy}
        onClick={() => { void person.run() }}>{t('gatewayCreatePerson')}</Button>
    </div>}
    {status?.login && status.person && <Hint>{t('gatewayPersonReady')}</Hint>}
    {status?.login && <form className="dt-form dt-block" onSubmit={event => { void deployment.run(event) }}>
      <div className="dt-field">
        <span className="dt-field-head">{t('gatewayDeploymentId')}</span>
        <span className="dt-input"><input value={id} onChange={event => setId(event.target.value)} required /></span>
      </div>
      <div className="dt-field">
        <span className="dt-field-head">{t('gatewayRepository')}</span>
        <span className="dt-input"><input value={repository} onChange={event => setRepository(event.target.value)} required /></span>
      </div>
      <Button type="submit" disabled={deployment.busy}>{t('gatewayCreateDeployment')}</Button>
    </form>}
    {status?.login && remote.length > 0 && <form className="dt-form dt-block"
      onSubmit={event => { event.preventDefault(); void credentials.run() }}>
      <div className="dt-field">
        <span className="dt-field-head">{t('gatewayCredentialsDeployment')}</span>
        <span className="dt-input"><select value={activeCredentialId} onChange={event => setCredentialId(event.target.value)}>
          {remote.map(deployment => <option key={deployment.id} value={deployment.id}>{deployment.id}</option>)}
        </select></span>
      </div>
      <div className="dt-field">
        <span className="dt-field-head">{t('gatewayAgentToken')}</span>
        <span className="dt-input"><input type="password" value={githubToken}
          onChange={event => setGithubToken(event.target.value)} required autoComplete="new-password" /></span>
      </div>
      <Button type="submit" disabled={credentials.busy}>{t('gatewayConfigureCredentials')}</Button>
    </form>}
  </article>
}

function DeploymentCard({ deployment, run, busy }: { deployment: Deployment; run: (id: string, action: Action) => Promise<unknown>
  busy: boolean }) {
  const { t, navigate, selectDeployment } = usePanel()
  const health = deployment.health.filter(item => item.state !== 'ready')
  return <article className="dt-card dt-fleet-card" data-status={deployment.status}>
    <div className="dt-card-head">
      <Dot state={dot(deployment.status)} label={t(`fleetStatus.${deployment.status}`)} />
      <div className="dt-row-main">
        <div className="dt-row-title"><span className="dt-card-title">{deployment.name}</span></div>
        <div className="dt-row-meta">
          <span className="dt-mono">{deployment.repository || deployment.stateDir}</span>
          <span>{t('fleetProfile')} {deployment.profile}</span>
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
      <Button variant="outline" size="sm" icon={<Icon name="settings" size={14} />}
        onClick={() => { selectDeployment(deployment.id); navigate({ page: 'overview' }) }}>{t('fleetManage')}</Button>
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
        <section className="dt-fleet-workspace">
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
      <CloudGateway reload={reload} deployments={data.deployments} selected={data.selected} />
      <div className="dt-fleet-grid">
        {data.deployments.map(deployment => <DeploymentCard key={deployment.id} deployment={deployment} run={act.run} busy={act.busy} />)}
      </div>
      <Hint>{data.configured ? t('fleetRegistry', { path: data.registryPath })
        : t('fleetRegistryMissing', { path: data.registryPath })}</Hint>
    </Section>
  </>
}
