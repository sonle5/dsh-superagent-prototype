/** Cloud identity, protected model gateway, deployment credentials, and effective role routes. */
import { useEffect, useState, type FormEvent } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll, type SettingsView } from './api.ts'
import { Button, Icon, Input, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Field, Fields } from './settings-kit.tsx'
import { errorText } from './text.ts'
import { Hint, LoadState, Section } from './widgets.tsx'

type ModelProxy = ApiResponse<'GET gateway/model-proxy'>
type ProxyProvider = ModelProxy['providers'][number]
type WritableProvider = Extract<ProxyProvider['id'], 'one-nexus' | 'openai'>

const tone = (state: ProxyProvider['state']) => state === 'connected' || state === 'configured' ? 'success'
  : state === 'error' ? 'danger' : state === 'missing' ? 'warning' : 'quiet'

function route(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (typeof item.provider !== 'string' || typeof item.model !== 'string') return route(item.model)
  return `${item.provider} / ${item.model}${typeof item.reasoningEffort === 'string' ? ` · ${item.reasoningEffort}` : ''}`
}

export function AccessSettings() {
  const { t, call, deployment, notify } = usePanel()
  const access = usePoll(async () => {
    const gateway = await call('GET gateway/status')
    const proxy = gateway.login ? await call('GET gateway/model-proxy') : undefined
    return { gateway, proxy }
  }, [call], 15_000)
  const roles = usePoll(
    () => deployment ? call('GET settings') : Promise.resolve<SettingsView | undefined>(undefined),
    [call, deployment?.id],
  )
  const [agentToken, setAgentToken] = useState('')
  const [provider, setProvider] = useState<WritableProvider>('one-nexus')
  const [providerKey, setProviderKey] = useState('')
  const [claudeWaiting, setClaudeWaiting] = useState(false)
  const [loginUrl, setLoginUrl] = useState<string>()
  const claude = usePoll(
    () => claudeWaiting ? call('GET gateway/model-proxy/claude/status') : Promise.resolve(undefined),
    [claudeWaiting, call],
    2_000,
  )
  useEffect(() => {
    if (claude.data?.state === 'connected') {
      setClaudeWaiting(false)
      setLoginUrl(undefined)
      notify(t('accessClaudeLinked'))
      void access.reload()
    } else if (claude.data?.state === 'error') {
      setClaudeWaiting(false)
      if (claude.data.error) notify(claude.data.error)
    }
  }, [access, claude.data, notify, t])
  const saveAgent = useAction(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!deployment || !agentToken) return
    await call('POST gateway/deployment/:id/credentials', { id: deployment.id, body: { githubToken: agentToken } })
    setAgentToken('')
    notify(t('gatewayCredentialsSaved'))
  })
  const saveProvider = useAction(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!providerKey) return
    await call('PUT gateway/model-proxy/provider/:provider', { provider, body: { apiKey: providerKey } })
    setProviderKey('')
    notify(t('accessProviderSaved'))
  }, { reload: access.reload })
  const protect = useAction(async () => {
    if (!deployment) return
    await call('POST fleet/:id/model-proxy', { id: deployment.id })
    notify(t('accessProtected'))
  }, { reload: async () => { await access.reload(); await roles.reload() } })
  const signOut = useAction(async () => {
    await call('DELETE gateway/session')
    notify(t('accessSignedOut'))
  }, { reload: access.reload })
  const connectClaude = async () => {
    const opened = window.open('about:blank', 'dsh-claude-login')
    if (opened) opened.opener = null
    try {
      const started = await call('POST gateway/model-proxy/claude/connect')
      setLoginUrl(started.url)
      setClaudeWaiting(true)
      if (opened) opened.location.replace(started.url)
    } catch (failure) {
      opened?.close()
      notify(errorText(failure))
    }
  }
  if (!access.data) return <LoadState error={access.error} loading />
  const gateway = access.data.gateway
  const proxy = access.data.proxy
  return <div className="dt-form dt-access">
    {access.error && <p className="dt-error" role="status">{access.error.message}</p>}
    <p className="dt-hint">{t('accessIntro')}</p>
    <Section title={t('accessHumanTitle')}>
      <div className="dt-access-row">
        <div>
          <strong>{gateway.login ? `@${gateway.login}` : t('gatewaySignedOut')}</strong>
          <p className="dt-hint">{gateway.organization || t('accessHumanHint')}</p>
        </div>
        {gateway.login && <Button variant="outline" size="sm" disabled={signOut.busy}
          onClick={() => { void signOut.run() }}>{t('accessSignOut')}</Button>}
      </div>
    </Section>
    <Section title={t('accessAgentTitle')}>
      <Hint>{t('accessAgentHint')}</Hint>
      <form className="dt-form" onSubmit={event => { void saveAgent.run(event) }}>
        <Fields disabled={saveAgent.busy || !deployment}>
          <Field label={t('gatewayAgentToken')} hint={deployment?.repository}>
            <Input type="password" autoComplete="new-password" value={agentToken} onChange={event => setAgentToken(event.target.value)} />
          </Field>
        </Fields>
        <Button type="submit" variant="primary" disabled={saveAgent.busy || !agentToken || !deployment}>
          {t('accessAgentSave')}</Button>
      </form>
    </Section>
    <Section title={t('accessModelsTitle')}>
      <Hint>{t('accessModelsHint')}</Hint>
      {!proxy ? <Hint>{t('gatewaySignIn')}</Hint> : <>
        <div className="dt-access-grid">
          {proxy.providers.map(item => <article className="dt-card dt-access-card" key={item.id}>
            <div className="dt-card-head"><span className="dt-card-title">{item.label}</span><Tag tone={tone(item.state)}>{item.state}</Tag></div>
            <p className="dt-mono">{item.id}</p>
            {item.id === 'claude' && item.state !== 'connected' && <div className="dt-row-buttons">
              <Button variant="primary" size="sm" icon={<Icon name="shield" size={14} />} disabled={claudeWaiting}
                onClick={() => { void connectClaude() }}>{claudeWaiting ? t('accessClaudeWaiting') : t('accessClaudeConnect')}</Button>
              {claudeWaiting && <Button variant="ghost" size="sm" onClick={() => {
                void call('DELETE gateway/model-proxy/claude/session').finally(() => {
                  setClaudeWaiting(false); setLoginUrl(undefined); void access.reload()
                })
              }}>{t('accessClaudeCancel')}</Button>}
            </div>}
            {item.id === 'claude' && loginUrl && <a className="dt-inline-link" href={loginUrl} target="_blank"
              rel="noopener noreferrer">{t('accessClaudeLink')}</a>}
          </article>)}
        </div>
        <form className="dt-form dt-access-provider" onSubmit={event => { void saveProvider.run(event) }}>
          <strong>{t('accessProviderKeyTitle')}</strong>
          <Fields disabled={saveProvider.busy}>
            <Field label={t('accessProvider')}>
              <select className="dt-select" value={provider} onChange={event => setProvider(event.target.value as WritableProvider)}>
                <option value="one-nexus">OneNexus</option>
                <option value="openai">OpenAI</option>
              </select>
            </Field>
            <Field label={t('accessProviderKey')} hint={t('providerKeyHint')}>
              <Input type="password" autoComplete="new-password" value={providerKey}
                onChange={event => setProviderKey(event.target.value)} />
            </Field>
          </Fields>
          <Button type="submit" variant="primary" disabled={saveProvider.busy || !providerKey}>{t('accessProviderSave')}</Button>
        </form>
        <div className="dt-access-protect">
          <div><strong>{t('accessProtectTitle')}</strong><p className="dt-hint">{t('accessProtectHint')}</p></div>
          <Button variant="outline" size="sm" icon={<Icon name="shield" size={14} />}
            disabled={protect.busy || !deployment} onClick={() => { void protect.run() }}>{t('accessProtect')}</Button>
        </div>
      </>}
    </Section>
    <Section title={t('accessRolesTitle')}>
      {roles.data ? <dl className="dt-kv dt-access-routes">
        <dt>{t('accessEvalRoute')}</dt><dd>{route(roles.data.blocks.eval.value) ?? t('accessRouteUnset')}</dd>
        <dt>{t('accessExecutorRoute')}</dt><dd>{route(roles.data.blocks.executor.value) ?? t('accessRouteUnset')}</dd>
      </dl> : <Hint>{roles.error?.message ?? t('loading')}</Hint>}
      <Hint>{t('accessRouteHint')}</Hint>
    </Section>
  </div>
}
