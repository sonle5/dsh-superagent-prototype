/** Deployment-scoped provider, credential, and model management backed by DSH's native settings APIs. */
import { useEffect, useState, type FormEvent } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button, Icon, Input, Modal, Tag } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Field, Fields } from './settings-kit.tsx'
import { errorText } from './text.ts'
import { ConfirmButton, Hint, LoadState } from './widgets.tsx'

type ProviderControl = ApiResponse<'GET fleet/:id/providers'>
type Provider = ProviderControl['providers'][number]
type ProviderModel = Provider['models'][number]
type ProviderApi = 'openai-completions' | 'anthropic-messages' | 'openai-responses'

interface ModelDraft {
  id: string
  name: string
  contextWindow: string
  maxTokens: string
  reasoning: boolean
  image: boolean
}
interface ProviderDraft {
  id: string
  displayName: string
  api: ProviderApi
  baseURL: string
  credentialRef: string
  apiKey: string
  models: ModelDraft[]
}

const modelDraft = (model?: ProviderModel): ModelDraft => ({
  id: model?.id ?? '',
  name: model?.name ?? '',
  contextWindow: model?.contextWindow === undefined ? '' : String(model.contextWindow),
  maxTokens: model?.maxTokens === undefined ? '' : String(model.maxTokens),
  reasoning: model?.reasoning ?? false,
  image: model?.image ?? false,
})

const blankModel = () => modelDraft()
const providerDraft = (provider?: Provider): ProviderDraft => provider ? {
  id: provider.id,
  displayName: provider.displayName,
  api: provider.api === 'anthropic-messages' || provider.api === 'openai-responses' ? provider.api : 'openai-completions',
  baseURL: provider.baseURL ?? '',
  credentialRef: provider.credentialRef ?? '',
  apiKey: '',
  models: provider.models.map(modelDraft),
} : {
  id: '',
  displayName: '',
  api: 'openai-completions',
  baseURL: '',
  credentialRef: '',
  apiKey: '',
  models: [blankModel()],
}

function ProviderEditor({ provider, revision, onClose, onSaved }: {
  provider?: Provider
  revision: number
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { t, call, deployment, notify } = usePanel()
  const [draft, setDraft] = useState(() => providerDraft(provider))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const edit = (patch: Partial<ProviderDraft>) => setDraft(value => ({ ...value, ...patch }))
  const editModel = (index: number, patch: Partial<ModelDraft>) => setDraft(value => ({
    ...value,
    models: value.models.map((model, at) => at === index ? { ...model, ...patch } : model),
  }))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!deployment) return
    const id = draft.id.trim()
    if (!/^[a-z][a-z0-9-]*$/.test(id)) return setError(t('providerIdInvalid'))
    if (!draft.displayName.trim()) return setError(t('providerNameRequired'))
    if (!draft.baseURL.trim()) return setError(t('providerURLRequired'))
    if (!draft.credentialRef.trim()) return setError(t('providerCredentialRefRequired'))
    if (!draft.models.length || draft.models.some(model => !model.id.trim() || !model.name.trim())) {
      return setError(t('providerModelsRequired'))
    }
    setBusy(true)
    setError(undefined)
    try {
      await call('PUT fleet/:id/providers/:provider', {
        id: deployment.id,
        provider: provider?.id ?? id,
        body: {
          displayName: draft.displayName.trim(),
          api: draft.api,
          baseURL: draft.baseURL.trim(),
          credentialRef: draft.credentialRef.trim(),
          ...draft.apiKey ? { apiKey: draft.apiKey } : {},
          models: draft.models.map(model => ({
            id: model.id.trim(),
            name: model.name.trim(),
            ...model.contextWindow.trim() ? { contextWindow: Number(model.contextWindow) } : {},
            ...model.maxTokens.trim() ? { maxTokens: Number(model.maxTokens) } : {},
            reasoning: model.reasoning,
            image: model.image,
          })),
          revision,
        },
      })
      await onSaved()
      notify(t('providerSaved'))
      onClose()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  const form = 'dt-provider-editor'
  return <Modal open onClose={onClose} title={t(provider ? 'providerEdit' : 'providerAdd')} closeLabel={t('close')}
    description={t(provider ? 'providerEditHint' : 'providerAddHint')} className="dt-provider-modal"
    footer={<>
      <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" type="submit" form={form} disabled={busy}>{t('save')}</Button>
    </>}>
    <form id={form} className="dt-form" onSubmit={event => { void submit(event) }}>
      <Fields disabled={busy}>
        {!provider && <div className="dt-provider-presets">
          <span>{t('providerPreset')}</span>
          <Button variant="outline" size="sm" onClick={() => setDraft({
            ...providerDraft(),
            id: 'one-nexus',
            displayName: 'One Nexus',
            baseURL: 'https://onenexus-ws.onenexus.cloud/v1',
            credentialRef: 'ONENEXUS_API_KEY',
            models: [{ id: 'glm-5.3-sontinh', name: 'GLM 5.3', contextWindow: '330000', maxTokens: '65000',
              reasoning: true, image: false }, { id: 'dsv41f-thuytinh', name: 'DeepSeek V4.1 Flash', contextWindow: '',
              maxTokens: '', reasoning: true, image: false }],
          })}>OneNexus</Button>
          <Button variant="outline" size="sm" onClick={() => setDraft({
            ...providerDraft(),
            id: 'claude-cpa',
            displayName: 'Claude via CPA',
            baseURL: 'https://your-cpa.example/v1',
            credentialRef: 'CLAUDE_API_KEY',
            models: [{ ...blankModel(), id: 'claude-opus-5-5(auto)', name: 'Claude Opus 5.5', reasoning: true, image: true }],
          })}>Claude / CPA</Button>
        </div>}
        <div className="dt-provider-form-grid">
          <Field label={t('providerId')}><Input value={draft.id} disabled={!!provider} spellCheck={false}
            onChange={event => edit({ id: event.target.value })} /></Field>
          <Field label={t('providerName')}><Input value={draft.displayName}
            onChange={event => edit({ displayName: event.target.value })} /></Field>
          <Field label={t('providerApi')}><select className="dt-select" value={draft.api}
            onChange={event => edit({ api: event.target.value as ProviderApi })}>
            <option value="openai-completions">OpenAI Chat Completions</option>
            <option value="openai-responses">OpenAI Responses</option>
            <option value="anthropic-messages">Anthropic Messages</option>
          </select></Field>
        </div>
        <Field label={t('providerBaseURL')}><Input value={draft.baseURL} inputMode="url" spellCheck={false}
          placeholder="https://provider.example/v1" onChange={event => edit({ baseURL: event.target.value })} /></Field>
        <div className="dt-provider-form-grid dt-provider-secret-grid">
          <Field label={t('providerCredentialRef')} hint={t('providerCredentialRefHint')}><Input value={draft.credentialRef}
            spellCheck={false} placeholder="PROVIDER_API_KEY" onChange={event => edit({ credentialRef: event.target.value })} /></Field>
          <Field label={t(provider ? 'providerKeyReplace' : 'providerKey')} hint={t('providerKeyHint')}>
            <Input type="password" autoComplete="new-password" value={draft.apiKey}
              placeholder={provider?.credential?.configured ? t('providerKeyConfiguredPlaceholder') : t('providerKeyOptional')}
              onChange={event => edit({ apiKey: event.target.value })} />
          </Field>
        </div>
        <div className="dt-provider-models-head">
          <div><strong>{t('providerModels')}</strong><small>{t('providerModelsHint')}</small></div>
          <Button variant="outline" size="sm" icon={<Icon name="plus" size={14} />}
            onClick={() => setDraft(value => ({ ...value, models: [...value.models, blankModel()] }))}>{t('providerAddModel')}</Button>
        </div>
        <div className="dt-provider-models">
          {draft.models.map((model, index) => <div className="dt-provider-model" key={index}>
            <div className="dt-provider-model-main">
              <Field label={t('providerModelId')}><Input value={model.id} spellCheck={false}
                onChange={event => editModel(index, { id: event.target.value })} /></Field>
              <Field label={t('providerModelName')}><Input value={model.name}
                onChange={event => editModel(index, { name: event.target.value })} /></Field>
            </div>
            <div className="dt-provider-model-limits">
              <Field label={t('providerContextWindow')}><Input type="number" min={1} value={model.contextWindow}
                onChange={event => editModel(index, { contextWindow: event.target.value })} /></Field>
              <Field label={t('providerMaxTokens')}><Input type="number" min={1} value={model.maxTokens}
                onChange={event => editModel(index, { maxTokens: event.target.value })} /></Field>
            </div>
            <div className="dt-provider-model-flags">
              <label><input type="checkbox" checked={model.reasoning}
                onChange={event => editModel(index, { reasoning: event.target.checked })} />{t('providerReasoning')}</label>
              <label><input type="checkbox" checked={model.image}
                onChange={event => editModel(index, { image: event.target.checked })} />{t('providerImages')}</label>
              <Button variant="ghost" size="sm" icon={<Icon name="trash" size={14} />}
                aria-label={t('providerRemoveModel', { model: model.name || model.id || index + 1 })}
                disabled={draft.models.length === 1}
                onClick={() => setDraft(value => ({ ...value, models: value.models.filter((_item, at) => at !== index) }))} />
            </div>
          </div>)}
        </div>
        {error && <p className="dt-error" role="alert">{error}</p>}
      </Fields>
    </form>
  </Modal>
}

function CredentialEditor({ provider, onClose, onSaved }: {
  provider: Provider
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { t, call, deployment, notify } = usePanel()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!deployment || !value) return
    setBusy(true)
    setError(undefined)
    try {
      await call('POST fleet/:id/providers/:provider/credential', {
        id: deployment.id, provider: provider.id, body: { value },
      })
      setValue('')
      await onSaved()
      notify(t('providerKeySaved'))
      onClose()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  return <Modal open onClose={onClose} title={t('providerKeyReplace')} closeLabel={t('close')}
    description={t('providerKeyReplaceHint', { provider: provider.displayName })}
    footer={<>
      <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" type="submit" form="dt-provider-credential" disabled={busy || !value}>{t('save')}</Button>
    </>}>
    <form id="dt-provider-credential" className="dt-form" onSubmit={event => { void submit(event) }}>
      <Fields disabled={busy}>
        <Field label={t('providerKey')} hint={t('providerKeyHint')}><Input type="password" autoComplete="new-password" value={value}
          autoFocus onChange={event => setValue(event.target.value)} /></Field>
        {error && <p className="dt-error" role="alert">{error}</p>}
      </Fields>
    </form>
  </Modal>
}

function ProviderCard({ provider, revision, writable, onReload }: {
  provider: Provider
  revision: number
  writable: boolean
  onReload: () => Promise<void>
}) {
  const { t, call, deployment, notify } = usePanel()
  const [editing, setEditing] = useState(false)
  const [credential, setCredential] = useState(false)
  const reset = async () => {
    if (!deployment) return
    await call('DELETE fleet/:id/providers/:provider', { id: deployment.id, provider: provider.id, body: { revision } })
    await onReload()
    notify(t('providerResetSaved'))
  }
  return <>
    <article className="dt-card dt-provider-card">
      <div className="dt-card-head">
        <div className="dt-row-main">
          <div className="dt-row-title"><span className="dt-card-title">{provider.displayName}</span>
            {provider.active ? <Tag tone="success">{t('providerActive')}</Tag> : <Tag tone="warning">{t('providerInactive')}</Tag>}
            {provider.removable && <Tag tone="neutral">{t('providerDeploymentOverride')}</Tag>}
          </div>
          <div className="dt-row-meta"><span className="dt-mono">{provider.id}</span><span>{provider.api ?? t('providerApiUnknown')}</span></div>
        </div>
        {writable && <div className="dt-actions">
          <Button variant="outline" size="sm" icon={<Icon name="settings" size={14} />} onClick={() => setEditing(true)}>
            {t('providerEdit')}
          </Button>
          {provider.credentialRef && <Button variant="ghost" size="sm" icon={<Icon name="shield" size={14} />}
            onClick={() => setCredential(true)}>{t('providerReplaceKey')}</Button>}
          {provider.removable && <ConfirmButton label={t('providerReset')} title={t('providerResetTitle')}
            message={t('providerResetHint', { provider: provider.displayName })} onConfirm={reset}
            icon="refresh" />}
        </div>}
      </div>
      {provider.error && <p className="dt-error" role="status">{provider.error}</p>}
      <dl className="dt-provider-facts">
        <div><dt>{t('providerBaseURL')}</dt><dd className="dt-mono">{provider.baseURL || t('unsetValue')}</dd></div>
        <div><dt>{t('providerCredential')}</dt><dd>
          <span className="dt-provider-credential" data-configured={provider.credential?.configured || undefined}>
            <span aria-hidden="true" />{provider.credential?.configured ? t('providerKeyConfigured') : t('providerKeyMissing')}
          </span>
          {provider.credentialRef && <span className="dt-mono">{provider.credentialRef}</span>}
          {provider.credential?.source && <span>{t('providerKeySource', { source: provider.credential.source })}</span>}
        </dd></div>
      </dl>
      <div className="dt-provider-model-list">
        <span className="dt-provider-model-list-title">{t('providerModels')}</span>
        {provider.models.length ? provider.models.map(model => <div className="dt-provider-model-row" key={model.id}>
          <span><strong>{model.name}</strong><code>{model.id}</code></span>
          <span className="dt-row-meta">
            {model.contextWindow !== undefined && <span>{t('providerContextShort', { value: model.contextWindow.toLocaleString() })}</span>}
            {model.maxTokens !== undefined && <span>{t('providerOutputShort', { value: model.maxTokens.toLocaleString() })}</span>}
            {model.reasoning && <Tag tone="quiet">{t('providerReasoning')}</Tag>}
            {model.image && <Tag tone="quiet">{t('providerImages')}</Tag>}
          </span>
        </div>) : <Hint>{t('providerNoModels')}</Hint>}
      </div>
    </article>
    {editing && <ProviderEditor provider={provider} revision={revision} onClose={() => setEditing(false)} onSaved={onReload} />}
    {credential && <CredentialEditor provider={provider} onClose={() => setCredential(false)} onSaved={onReload} />}
  </>
}

export function ProvidersSettings() {
  const { t, call, deployment } = usePanel()
  const { data, error, reload } = usePoll(
    () => deployment ? call('GET fleet/:id/providers', { id: deployment.id }) : Promise.resolve(undefined),
    [call, deployment?.id],
  )
  const [adding, setAdding] = useState(false)
  useEffect(() => { setAdding(false) }, [deployment?.id])
  if (!data) return <LoadState error={error} loading />
  return <div className="dt-form">
    {error && <p className="dt-error" role="status">{error.message}</p>}
    <div className="dt-provider-intro">
      <div>
        <Hint>{t('providerIntro')}</Hint>
        {data.credentialError && <p className="dt-error" role="alert">{t('providerCredentialError', { error: data.credentialError })}</p>}
      </div>
      {data.writable && <Button variant="primary" size="sm" icon={<Icon name="plus" size={14} />}
        onClick={() => setAdding(true)}>{t('providerAdd')}</Button>}
    </div>
    <div className="dt-provider-list">
      {data.providers.map(provider => <ProviderCard key={provider.id} provider={provider} revision={data.revision}
        writable={data.writable} onReload={reload} />)}
      {!data.providers.length && <Hint>{t('providerNone')}</Hint>}
    </div>
    <p className="dt-hint">{t('providerEffectsHint')}</p>
    {adding && <ProviderEditor revision={data.revision} onClose={() => setAdding(false)} onSaved={reload} />}
  </div>
}
