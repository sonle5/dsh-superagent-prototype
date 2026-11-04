/** Deployment-scoped identities and value transforms for the native DSH transport. */
import type { FleetNativeTarget } from './fleet.ts'

const ID_PREFIX = 'dsh-superagent'
const SESSION_KIND = 'session'
const WORKSPACE_KIND = 'workspace'
const EVENT_KIND = 'event'
const SESSION_FIELDS = new Set(['sessionId', 'parentSessionId', 'childSessionId'])
const WORKSPACE_FIELDS = new Set(['workspaceId', 'beforeWorkspaceId'])
const SESSION_ARRAY_FIELDS = new Set(['sessionIds', 'archivedSessionIds', 'pinnedSessionIds'])
const WORKSPACE_ARRAY_FIELDS = new Set(['workspaceIds'])

type ScopedKind = typeof SESSION_KIND | typeof WORKSPACE_KIND | typeof EVENT_KIND
type JsonRecord = Record<string, unknown>

function scopedId(kind: ScopedKind, deployment: string, id: string): string {
  if (deployment === '' || id === '') throw new Error('Native aggregate ids require non-empty deployment and resource ids')
  return [
    ID_PREFIX,
    kind,
    Buffer.from(deployment, 'utf8').toString('base64url'),
    Buffer.from(id, 'utf8').toString('base64url'),
  ].join('.')
}

/**
 * Encode one Session id so it remains globally unique in the aggregate sidebar.
 * @param deployment - Stable deployment id.
 * @param sessionId - Peer-local Session id.
 * @returns Deployment-scoped native Session id.
 */
export function nativeSessionId(deployment: string, sessionId: string): string {
  return scopedId(SESSION_KIND, deployment, sessionId)
}

/**
 * Encode one Workspace id so it remains globally unique in the aggregate sidebar.
 * @param deployment - Stable deployment id.
 * @param workspaceId - Peer-local Workspace id.
 * @returns Deployment-scoped native Workspace id.
 */
export function nativeWorkspaceId(deployment: string, workspaceId: string): string {
  return scopedId(WORKSPACE_KIND, deployment, workspaceId)
}

/**
 * Encode one peer-local Remote event id so result calls can be routed back to its owner.
 * @param deployment - Stable deployment id.
 * @param eventId - Peer-local event correlation id.
 * @returns Deployment-scoped event id.
 */
export function nativeEventId(deployment: string, eventId: string): string {
  return scopedId(EVENT_KIND, deployment, eventId)
}

function decodeScopedId(value: string, kind: ScopedKind): { deployment: string; id: string } | undefined {
  const parts = value.split('.')
  if (parts.length !== 4 || parts[0] !== ID_PREFIX || parts[1] !== kind || parts[2] === '' || parts[3] === '') return undefined
  try {
    const deployment = Buffer.from(parts[2]!, 'base64url')
    const id = Buffer.from(parts[3]!, 'base64url')
    if (deployment.toString('base64url') !== parts[2] || id.toString('base64url') !== parts[3]) return undefined
    return {
      deployment: deployment.toString('utf8'),
      id: id.toString('utf8'),
    }
  } catch {
    return undefined
  }
}

/**
 * Decode one aggregate Session id.
 * @param value - Possible aggregate id.
 * @returns Deployment and peer-local Session identity.
 */
export function deploymentSession(value: string): { deployment: string; id: string } | undefined {
  return decodeScopedId(value, SESSION_KIND)
}

/**
 * Decode one aggregate Workspace id.
 * @param value - Possible aggregate id.
 * @returns Deployment and peer-local Workspace identity.
 */
export function deploymentWorkspace(value: string): { deployment: string; id: string } | undefined {
  return decodeScopedId(value, WORKSPACE_KIND)
}

/**
 * Decode one aggregate Remote event id.
 * @param value - Possible aggregate id.
 * @returns Deployment and peer-local event identity.
 */
export function deploymentEvent(value: string): { deployment: string; id: string } | undefined {
  return decodeScopedId(value, EVENT_KIND)
}

/**
 * Replace aggregate identities in one outbound RPC payload with their peer-local values.
 * @param value - JSON-safe request value.
 * @returns A transformed copy.
 */
export function peerRequestValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return deploymentSession(value)?.id ?? deploymentWorkspace(value)?.id ?? deploymentEvent(value)?.id ?? value
  }
  if (Array.isArray(value)) return value.map(peerRequestValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    deploymentSession(key)?.id ?? deploymentWorkspace(key)?.id ?? deploymentEvent(key)?.id ?? key,
    peerRequestValue(item),
  ]))
}

/**
 * Find every deployment named by aggregate identities in a request payload.
 * @param value - JSON-safe request value.
 * @returns Distinct deployment ids in encounter order.
 */
export function requestDeployments(value: unknown): string[] {
  const found = new Set<string>()
  const visit = (item: unknown): void => {
    if (typeof item === 'string') {
      const decoded = deploymentSession(item) ?? deploymentWorkspace(item) ?? deploymentEvent(item)
      if (decoded !== undefined) found.add(decoded.deployment)
      return
    }
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry)
      return
    }
    if (!isRecord(item)) return
    for (const [key, entry] of Object.entries(item)) {
      visit(key)
      visit(entry)
    }
  }
  visit(value)
  return [...found]
}

/**
 * Select the sole owner of a request, falling back only when no aggregate identity is present.
 * @param value - JSON-safe request value.
 * @param targets - Registered peers.
 * @param fallback - Management-context peer for unscoped operations.
 * @returns Owning peer.
 */
export function requestOwner(
  value: unknown,
  targets: readonly FleetNativeTarget[],
  fallback: FleetNativeTarget,
): FleetNativeTarget {
  const deployments = requestDeployments(value)
  if (deployments.length > 1) throw new Error(`Request spans multiple deployments: ${deployments.join(', ')}`)
  const target = deployments.length === 0 ? fallback : targets.find(item => item.id === deployments[0])
  if (target === undefined) throw new Error(`Request names an unknown deployment: ${deployments[0]}`)
  return target
}

function mapSession(value: unknown, deployment: string): unknown {
  return typeof value === 'string' ? nativeSessionId(deployment, value) : value
}

function mapWorkspace(value: unknown, deployment: string): unknown {
  return typeof value === 'string' ? nativeWorkspaceId(deployment, value) : value
}

function mapSessionRecord(value: unknown, deployment: string): unknown {
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([id, item]) => [
    id === '' ? id : nativeSessionId(deployment, id),
    peerResponseValue(item, deployment),
  ]))
}

/**
 * Replace peer-local identities in one response or stream frame with aggregate ids.
 * @param value - JSON-safe peer value.
 * @param deployment - Deployment that produced the value.
 * @param parent - Parent field name used for ambiguous id fields.
 * @returns A transformed copy.
 */
export function peerResponseValue(value: unknown, deployment: string, parent?: string): unknown {
  if (Array.isArray(value)) {
    if (parent !== undefined && SESSION_ARRAY_FIELDS.has(parent)) return value.map(item => mapSession(item, deployment))
    if (parent !== undefined && WORKSPACE_ARRAY_FIELDS.has(parent)) return value.map(item => mapWorkspace(item, deployment))
    if (parent === 'subagentCatalog') {
      return value.map(item => isRecord(item) && typeof item.id === 'string'
        ? { ...peerResponseValue(item, deployment) as JsonRecord, id: nativeSessionId(deployment, item.id) }
        : peerResponseValue(item, deployment))
    }
    return value.map(item => peerResponseValue(item, deployment))
  }
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (SESSION_FIELDS.has(key)) return [key, mapSession(item, deployment)]
    if (WORKSPACE_FIELDS.has(key)) return [key, mapWorkspace(item, deployment)]
    if (key === 'jobs' || key === 'projections') return [key, mapSessionRecord(item, deployment)]
    return [key, peerResponseValue(item, deployment, key)]
  }))
}

/** Prefix one human-facing title with the repository that owns it; the Desktop's own titles (no repository) stay as they are. */
export function repositoryTitle(repository: string, title: string): string {
  if (repository === '') return title
  const prefix = `${repository} · `
  return title.startsWith(prefix) ? title : `${prefix}${title}`
}

function projectionValues(value: unknown, target: FleetNativeTarget): unknown {
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === 'title' && typeof item === 'string'
      ? repositoryTitle(target.repository, item)
      : peerResponseValue(item, target.id, key),
  ]))
}

function projectionBaseline(value: unknown, target: FleetNativeTarget): unknown {
  if (!isRecord(value)) return value
  return {
    ...value,
    ...isRecord(value.values) ? { values: projectionValues(value.values, target) } : {},
  }
}

/**
 * Remap one Session projection read while keeping its Session title attributable to the repository.
 * @param value - Peer-local projections response.
 * @param target - Peer that produced the response.
 * @returns Aggregate projection response.
 */
export function peerSessionProjectionsValue(value: unknown, target: FleetNativeTarget): unknown {
  const mapped = peerResponseValue(value, target.id)
  return projectionBaseline(mapped, target)
}

/**
 * Remap one Session-list page. Each row's `projections` is that Session's own block (`kind`, `asOfSeq`, `values`),
 * not a map keyed by Session id, so it keeps its fields and only its values are remapped.
 * @param value - Peer-local Session-list response.
 * @param target - Peer that produced the response.
 * @returns Aggregate Session-list response.
 */
export function peerSessionListValue(value: unknown, target: FleetNativeTarget): unknown {
  if (!isRecord(value) || !Array.isArray(value.items)) return peerResponseValue(value, target.id)
  return {
    ...peerResponseValue(value, target.id) as JsonRecord,
    items: value.items.map(item => {
      if (!isRecord(item) || !isRecord(item.projections)) return peerResponseValue(item, target.id)
      const { projections, ...row } = item
      return { ...peerResponseValue(row, target.id) as JsonRecord, projections: projectionBaseline(projections, target) }
    }),
  }
}

/**
 * Remap a Session follow frame, including the otherwise ambiguous ids in its opening header.
 * @param value - Peer-local Session follow frame.
 * @param target - Peer that produced the frame.
 * @returns Aggregate follow frame.
 */
export function peerSessionFollowValue(value: unknown, target: FleetNativeTarget): unknown {
  const mapped = peerResponseValue(value, target.id)
  if (!isRecord(value) || value.type !== 'snapshot' || !isRecord(value.header)) return mapped
  if (!isRecord(mapped)) return mapped
  const header = isRecord(mapped.header) ? mapped.header : {}
  return {
    ...mapped,
    header: {
      ...header,
      id: mapSession(value.header.id, target.id),
      ...value.header.parentSession === undefined
        ? {}
        : { parentSession: mapSession(value.header.parentSession, target.id) },
    },
    projections: isRecord(value.projections)
      ? projectionBaseline(value.projections, target)
      : mapped.projections,
  }
}

/**
 * Remap one Session control frame and attribute Session titles to their repository.
 * @param value - Peer-local control frame.
 * @param target - Peer that produced the frame.
 * @returns Aggregate control frame.
 */
export function peerSessionControlValue(value: unknown, target: FleetNativeTarget): unknown {
  const mapped = peerResponseValue(value, target.id)
  if (!isRecord(value) || !isRecord(mapped)) return mapped
  if (value.type === 'projection' && value.key === 'title' && typeof value.value === 'string') {
    return { ...mapped, value: repositoryTitle(target.repository, value.value) }
  }
  if (value.type !== 'baseline' || !isRecord(value.value) || !isRecord(value.value.projections)) return mapped
  const frameValue = isRecord(mapped.value) ? mapped.value : {}
  return {
    ...mapped,
    value: {
      ...frameValue,
      projections: Object.fromEntries(Object.entries(value.value.projections).map(([sessionId, projection]) => [
        nativeSessionId(target.id, sessionId),
        projectionBaseline(projection, target),
      ])),
    },
  }
}

/**
 * Merge peer Session-list values into one recency-ordered aggregate list.
 * @param values - Successful peer values in registry order.
 * @returns Aggregate Session list.
 */
export function mergeSessionLists(values: readonly unknown[]): { items: unknown[] } {
  return {
    items: values
      .flatMap(value => isRecord(value) && Array.isArray(value.items) ? value.items : [])
      .sort((left, right) => numberField(right, 'updatedAt') - numberField(left, 'updatedAt')),
  }
}

/**
 * Merge peer content-search values without exceeding the protocol's result bound.
 * @param values - Successful peer search values in registry order.
 * @param limit - Maximum aggregate result count.
 * @returns Aggregate search result.
 */
export function mergeSessionSearches(values: readonly unknown[], limit: number): { items: unknown[]; hasMore: boolean } {
  const items = values.flatMap(value => isRecord(value) && Array.isArray(value.items) ? value.items : [])
  return {
    items: items.slice(0, limit),
    hasMore: items.length > limit || values.some(value => isRecord(value) && value.hasMore === true),
  }
}

function numberField(value: unknown, key: string): number {
  return isRecord(value) && typeof value[key] === 'number' ? value[key] : 0
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
