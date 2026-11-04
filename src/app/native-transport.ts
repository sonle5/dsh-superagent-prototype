/** Deployment-aware native DSH HTTP and Remote-stream transport for the Desktop control plane. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { isLoopbackHost } from '@deepseek-ai/dsh-host-webserver'
import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable, type Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { Fleet, FleetControlError, redactSensitive, type FleetNativeTarget } from './fleet.ts'
import {
  mergeSessionLists,
  mergeSessionSearches,
  nativeEventId,
  nativeSessionId,
  nativeWorkspaceId,
  peerSessionControlValue,
  peerSessionFollowValue,
  peerSessionProjectionsValue,
  peerRequestValue,
  peerResponseValue,
  repositoryTitle,
  requestOwner,
} from './native-aggregate.ts'
import { matchesNativeToken, nativeToken } from './native-auth.ts'

const NATIVE_API = '/orchestrator/native/api'
const NATIVE_MUX = '/orchestrator/native/remote.mux'
const INTERNAL_REQUEST_HEADER = 'x-orchestrator-request'
const INTERNAL_HEADER = 'x-dsh-superagent-native'
/** Marks the controller's request to its own API; its value lives only in this process. */
const LOCAL_HEADER = 'x-dsh-superagent-local'
const MAX_RPC_BODY_BYTES = 300 * 1024 * 1024
const SESSION_SEARCH_RESULT_LIMIT = 20
const PEER_REQUEST_TIMEOUT_MS = 10_000
const STREAM_BASELINE_TIMEOUT_MS = 2_000
const UPSTREAM_OPEN_TIMEOUT_MS = 10_000
const HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'origin',
  'proxy-authenticate',
  'proxy-authorization',
  'sec-fetch-site',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  INTERNAL_REQUEST_HEADER,
  INTERNAL_HEADER,
  LOCAL_HEADER,
])

type NativeRole = 'control' | 'repository'

/**
 * Peer id of the controller profile's own Sessions. Registry ids cannot contain a dot, so it never names a deployment.
 * Sessions a person starts in Desktop, in any mode, belong to this profile rather than to a Superagent deployment.
 */
const LOCAL_TARGET_ID = 'desktop.local'

/** The controller profile as a peer: it serves its own Session catalog through the repository half of the transport. */
function localTarget(ctx: Context, stateDir: string): FleetNativeTarget {
  return {
    id: LOCAL_TARGET_ID,
    url: `http://127.0.0.1:${ctx.webServer.port}/`,
    repository: '',
    profile: '',
    stateDir,
    workspace: '',
    token: nativeToken(stateDir)!,
  }
}

/** Name of a peer in diagnostics. */
function peerLabel(target: FleetNativeTarget): string {
  return target.id === LOCAL_TARGET_ID ? 'Desktop' : target.repository
}

/**
 * Whether a Desktop-profile Session or Workspace path lies under a deployment's state directory.
 * The deployment's own store is authoritative for such work; older Desktop-profile copies are hidden from the catalog.
 */
function deploymentOwnedPath(target: FleetNativeTarget, path: unknown, targets: readonly FleetNativeTarget[]): boolean {
  if (target.id !== LOCAL_TARGET_ID || typeof path !== 'string') return false
  return targets.some(peer => peer.id !== LOCAL_TARGET_ID && (path === peer.stateDir || path.startsWith(`${peer.stateDir}/`)))
}

function withoutDeploymentSessions(target: FleetNativeTarget, value: unknown, targets: readonly FleetNativeTarget[]): unknown {
  if (!isRecord(value) || !Array.isArray(value.items)) return value
  return { ...value, items: value.items.filter(item => !isRecord(item) || !deploymentOwnedPath(target, item.cwd, targets)) }
}

function requestTarget(request: IncomingMessage): { host: string; origin?: string } | undefined {
  const host = request.headers.host
  if (host === undefined) return undefined
  const origin = request.headers.origin
  return { host, ...typeof origin === 'string' ? { origin } : {} }
}

function internalRequest(request: IncomingMessage, port: number, stateDir: string): boolean {
  const target = requestTarget(request)
  if (target === undefined || target.host !== `127.0.0.1:${port}` && target.host !== `localhost:${port}`) return false
  if (request.headers[INTERNAL_REQUEST_HEADER] !== '1' || !matchesNativeToken(stateDir, request.headers[INTERNAL_HEADER])) return false
  return target.origin === undefined || target.origin === `http://${target.host}`
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of response.headers) {
    // fetch has already decoded the body, so its original encoding no longer describes it.
    if (!HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== 'content-encoding') headers[name] = value
  }
  return headers
}

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, responseHeaders(response))
  if (response.body === null) {
    res.end()
    return
  }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise<void>(resolve => {
        const done = (): void => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.once('drain', done)
        res.once('close', done)
      })
    }
  }
  res.end()
}

function abortOnDisconnect(res: ServerResponse): AbortController {
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  return abort
}

async function proxyHttp(req: IncomingMessage, res: ServerResponse, target: URL, extra: Record<string, string>): Promise<void> {
  const abort = abortOnDisconnect(res)
  const method = req.method ?? 'GET'
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_HEADERS.has(name.toLowerCase()) || value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  const bodyless = method === 'GET' || method === 'HEAD'
  const response = await fetch(target, {
    method,
    headers,
    ...bodyless ? {} : { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' },
    redirect: 'error',
    signal: abort.signal,
  } as RequestInit & { duplex: 'half' })
  await writeResponse(response, res)
}

async function proxyBufferedHttp(
  req: IncomingMessage,
  res: ServerResponse,
  target: URL,
  body: Buffer,
  extra: Record<string, string>,
): Promise<void> {
  const abort = abortOnDisconnect(res)
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_HEADERS.has(name.toLowerCase()) || value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  const response = await fetch(target, {
    method: req.method ?? 'POST',
    headers,
    body: new Uint8Array(body),
    redirect: 'error',
    signal: abort.signal,
  })
  await writeResponse(response, res)
}

function relaySockets(client: WebSocket, upstream: WebSocket, initial: { data: RawData; binary: boolean }[] = []): void {
  const pending = [...initial]
  let clientClosed = false
  let upstreamClosed = false
  const closeBoth = (code: number, reason: Buffer): void => {
    const relayCode = (code >= 1000 && code <= 1014 && code !== 1005 && code !== 1006) || code >= 3000 && code <= 4999
      ? code : 1000
    if (!clientClosed) {
      clientClosed = true
      client.close(relayCode, reason)
    }
    if (!upstreamClosed) {
      upstreamClosed = true
      upstream.close(relayCode, reason)
    }
  }
  client.on('message', (data, binary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
    else if (upstream.readyState === WebSocket.CONNECTING) pending.push({ data, binary })
  })
  client.on('close', (code, reason) => closeBoth(code, reason))
  client.on('error', () => upstream.terminate())
  upstream.on('open', () => {
    for (const item of pending.splice(0)) upstream.send(item.data, { binary: item.binary })
  })
  upstream.on('message', (data, binary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary })
  })
  upstream.on('close', (code, reason) => closeBoth(code, reason))
  upstream.on('error', () => client.terminate())
}

function webSocketUrl(base: string, path: string): string {
  const url = new URL(path, base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

interface ClientRpcEnvelope {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

interface ServerRpcEnvelope {
  type: 'server-response'
  rpcId: string
  result:
    | { ok: true; value: unknown }
    | { ok: false; error: { code: string; message: string; details: object } }
}

interface NativeControllerState {
  /** Controller event-stream client ids mapped to each peer's local generation. */
  readonly eventClients: Map<string, Map<string, string>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bindEventClient(
  state: NativeControllerState,
  targetId: string,
  controllerClientId: string,
  localClientId: string,
): void {
  let clients = state.eventClients.get(targetId)
  if (clients === undefined) {
    clients = new Map()
    state.eventClients.set(targetId, clients)
  }
  clients.set(controllerClientId, localClientId)
}

function localEventClient(
  state: NativeControllerState,
  targetId: string,
  controllerClientId: string,
): string | undefined {
  return state.eventClients.get(targetId)?.get(controllerClientId)
}

function unbindEventClient(
  state: NativeControllerState,
  targetId: string,
  controllerClientId: string,
): void {
  const clients = state.eventClients.get(targetId)
  if (clients === undefined) return
  clients.delete(controllerClientId)
  if (clients.size === 0) state.eventClients.delete(targetId)
}

function eventResultClientId(value: unknown): string | undefined {
  const args = isRecord(value) ? value.args : undefined
  const request = Array.isArray(args) ? args[0] : args
  return isRecord(request) && typeof request.clientId === 'string' ? request.clientId : undefined
}

function clientEnvelope(value: unknown): ClientRpcEnvelope | undefined {
  if (!isRecord(value)
    || value.type !== 'client-request'
    || typeof value.rpcId !== 'string'
    || typeof value.method !== 'string'
    || !isRecord(value.payload)) return undefined
  return value as unknown as ClientRpcEnvelope
}

function serverEnvelope(value: unknown, rpcId: string): ServerRpcEnvelope | undefined {
  if (!isRecord(value) || value.type !== 'server-response' || value.rpcId !== rpcId || !isRecord(value.result)) return undefined
  const result = value.result
  if (result.ok === true && Object.hasOwn(result, 'value')) {
    return value as unknown as ServerRpcEnvelope
  }
  if (result.ok === false
    && isRecord(result.error)
    && typeof result.error.code === 'string'
    && typeof result.error.message === 'string'
    && isRecord(result.error.details)) {
    return value as unknown as ServerRpcEnvelope
  }
  return undefined
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const declared = request.headers['content-length']
  if (declared !== undefined && Number(declared) > MAX_RPC_BODY_BYTES) {
    throw new RangeError(`RPC request exceeds ${MAX_RPC_BODY_BYTES} bytes`)
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    received += buffer.byteLength
    if (received > MAX_RPC_BODY_BYTES) throw new RangeError(`RPC request exceeds ${MAX_RPC_BODY_BYTES} bytes`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function nativeHeaders(target: FleetNativeTarget): Record<string, string> {
  return { [INTERNAL_REQUEST_HEADER]: '1', [INTERNAL_HEADER]: target.token }
}

function peerSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(PEER_REQUEST_TIMEOUT_MS)])
}

function withoutRepositoryTitle(repository: string, value: unknown): unknown {
  if (typeof value !== 'string' || repository === '') return value
  const prefix = `${repository} · `
  return value.startsWith(prefix) ? value.slice(prefix.length) : value
}

function requestArgs(value: unknown): readonly unknown[] {
  return isRecord(value) && Array.isArray(value.args) ? value.args : []
}

function outboundPeerPayload(target: FleetNativeTarget, endpoint: string, value: unknown): unknown {
  const mapped = peerRequestValue(value)
  if (endpoint !== 'session/rename' && endpoint !== 'workspace/rename' || !isRecord(mapped)) return mapped
  const args = requestArgs(mapped)
  const request = args[0]
  if (!isRecord(request) || typeof request.title !== 'string') return mapped
  const title = withoutRepositoryTitle(target.repository, request.title)
  return {
    ...mapped,
    args: [{ ...request, title }, ...args.slice(1)],
  }
}

function responseValue(target: FleetNativeTarget, endpoint: string, value: unknown): unknown {
  if (endpoint === 'session/follow') return peerSessionFollowValue(value, target)
  if (endpoint === 'session/projections') return peerSessionProjectionsValue(value, target)
  if (endpoint === 'session/control') return peerSessionControlValue(value, target)
  const mapped = peerResponseValue(value, target.id)
  if (endpoint !== 'session/rename' && endpoint !== 'workspace/rename') return mapped
  if (!isRecord(mapped) || typeof mapped.title !== 'string') return mapped
  return { ...mapped, title: repositoryTitle(target.repository, mapped.title) }
}

async function callPeer(
  target: FleetNativeTarget,
  sourcePath: string,
  envelope: ClientRpcEnvelope,
  signal: AbortSignal,
): Promise<ServerRpcEnvelope> {
  const targetUrl = new URL(`/orchestrator/native${sourcePath}`, target.url)
  const payload = outboundPeerPayload(target, envelope.method, envelope.payload)
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...nativeHeaders(target) },
    body: JSON.stringify({
      ...envelope,
      payload,
    }),
    redirect: 'error',
    signal: peerSignal(signal),
  })
  if (!response.ok) throw new Error(`${response.status} from ${peerLabel(target)}`)
  const parsed = serverEnvelope(await response.json() as unknown, envelope.rpcId)
  if (parsed === undefined) throw new Error(`Invalid native response from ${peerLabel(target)}`)
  return parsed
}

function aggregateFailure(rpcId: string, message: string, code = 'gateway/internal'): ServerRpcEnvelope {
  return {
    type: 'server-response',
    rpcId,
    result: {
      ok: false,
      error: { code, message, details: {} },
    },
  }
}

async function aggregateRpc(
  targets: readonly FleetNativeTarget[],
  sourcePath: string,
  envelope: ClientRpcEnvelope,
  fallback: FleetNativeTarget,
  state: NativeControllerState,
  signal: AbortSignal,
): Promise<ServerRpcEnvelope> {
  if (envelope.method !== 'session/list' && envelope.method !== 'session/search') {
    let target: FleetNativeTarget
    try {
      target = requestOwner(envelope.payload, targets, fallback)
    } catch (error) {
      return aggregateFailure(
        envelope.rpcId,
        redactSensitive(error instanceof Error ? error.message : String(error)),
        'gateway/bad-request',
      )
    }
    let request = envelope
    if (envelope.method === '$events/result' && isRecord(envelope.payload)) {
      const controllerClientId = eventResultClientId(envelope.payload)
      if (controllerClientId === undefined) {
        return aggregateFailure(envelope.rpcId, 'Remote event result requires a client id', 'gateway/bad-request')
      }
      const clientId = localEventClient(state, target.id, controllerClientId)
      if (clientId === undefined) {
        return aggregateFailure(envelope.rpcId, `Remote event stream is unavailable for ${peerLabel(target)}`)
      }
      const args = envelope.payload.args
      if (Array.isArray(args) && isRecord(args[0]) && typeof args[0].clientId === 'string') {
        request = {
          ...envelope,
          payload: {
            ...envelope.payload,
            args: [{ ...args[0], clientId }, ...args.slice(1)],
          },
        }
      } else if (isRecord(args) && typeof args.clientId === 'string') {
        request = {
          ...envelope,
          payload: {
            ...envelope.payload,
            args: { ...args, clientId },
          },
        }
      }
    }
    let response: ServerRpcEnvelope
    try {
      response = await callPeer(target, sourcePath, request, signal)
    } catch (error) {
      return aggregateFailure(
        envelope.rpcId,
        redactSensitive(`${peerLabel(target)} is unavailable: ${error instanceof Error ? error.message : String(error)}`),
      )
    }
    if (!response.result.ok) {
      return {
        ...response,
        result: {
          ok: false,
          error: {
            ...response.result.error,
            details: peerResponseValue(response.result.error.details, target.id) as Record<string, unknown>,
          },
        },
      }
    }
    return {
      ...response,
      result: { ok: true, value: responseValue(target, envelope.method, response.result.value) },
    }
  }

  const responses = await Promise.allSettled(targets.map(target => callPeer(target, sourcePath, envelope, signal)))
  const successful: unknown[] = []
  for (let index = 0; index < responses.length; index++) {
    const response = responses[index]!
    if (response.status !== 'fulfilled' || !response.value.result.ok) continue
    const value = responseValue(targets[index]!, envelope.method, response.value.result.value)
    successful.push(envelope.method === 'session/list' ? withoutDeploymentSessions(targets[index]!, value, targets) : value)
  }
  if (successful.length === 0) {
    const detail = responses
      .map((response, index) => response.status === 'rejected'
        ? `${peerLabel(targets[index]!)}: ${response.reason instanceof Error ? response.reason.message : String(response.reason)}`
        : response.value.result.ok
          ? undefined
          : `${peerLabel(targets[index]!)}: ${response.value.result.error.message}`)
      .filter((value): value is string => value !== undefined)
      .join('; ')
    return aggregateFailure(envelope.rpcId, redactSensitive(`No deployment answered ${envelope.method}${detail ? ` (${detail})` : ''}`))
  }
  return {
    type: 'server-response',
    rpcId: envelope.rpcId,
    result: {
      ok: true,
      value: envelope.method === 'session/list'
        ? mergeSessionLists(successful)
        : mergeSessionSearches(successful, SESSION_SEARCH_RESULT_LIMIT),
    },
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

function acceptUpgrade(server: WebSocketServer, request: IncomingMessage, socket: Duplex, head: Buffer,
  open: (client: WebSocket) => void): void {
  server.handleUpgrade(request, socket, head, (client) => {
    server.emit('connection', client, request)
    open(client)
  })
}

interface RemoteStreamFailure {
  code: string
  message: string
  details: object
}

interface OpenUpstreamOptions {
  onItem(value: unknown): void
  onError(error: RemoteStreamFailure): void
  onEnd(): void
  onReady?(): void
}

interface UpstreamStream {
  send(value: unknown): void
  end(): void
  close(): void
}

function openUpstreamStream(
  target: FleetNativeTarget,
  endpoint: string,
  payload: unknown,
  options: OpenUpstreamOptions,
): UpstreamStream {
  const streamId = randomUUID()
  const socket = new WebSocket(webSocketUrl(target.url, NATIVE_MUX), { headers: nativeHeaders(target) })
  let closed = false
  let ended = false
  let opened = false
  const pending: (
    | { type: 'item'; value?: unknown }
    | { type: 'end' }
  )[] = []
  const finish = (): void => {
    if (ended) return
    ended = true
    options.onEnd()
  }
  const failure = (error: RemoteStreamFailure): void => {
    if (ended) return
    ended = true
    options.onError(error)
  }
  const openTimer = setTimeout(() => {
    failure({ code: 'gateway/service-unavailable', message: `${peerLabel(target)} Remote stream did not open`, details: {} })
    socket.terminate()
  }, UPSTREAM_OPEN_TIMEOUT_MS)
  socket.on('open', () => {
    opened = true
    clearTimeout(openTimer)
    options.onReady?.()
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }))
    for (const item of pending.splice(0)) socket.send(JSON.stringify({ streamId, ...item }))
  })
  socket.on('message', (data, binary) => {
    if (binary) return
    let frame: unknown
    try {
      frame = JSON.parse(data.toString()) as unknown
    } catch {
      failure({ code: 'gateway/internal', message: 'Invalid upstream Remote-stream frame', details: {} })
      return
    }
    if (!isRecord(frame) || frame.streamId !== streamId) return
    if (frame.type === 'item') {
      options.onItem(frame.value)
      return
    }
    if (frame.type === 'end') {
      finish()
      return
    }
    if (frame.type === 'error' && isRecord(frame.error)
      && typeof frame.error.code === 'string'
      && typeof frame.error.message === 'string'
      && isRecord(frame.error.details)) {
      failure(frame.error as unknown as RemoteStreamFailure)
    }
  })
  socket.on('error', () => {
    clearTimeout(openTimer)
    if (!closed) failure({ code: 'gateway/internal', message: `${peerLabel(target)} Remote stream failed`, details: {} })
  })
  socket.on('close', () => {
    clearTimeout(openTimer)
    if (!closed) failure({ code: 'gateway/internal', message: `${peerLabel(target)} Remote stream closed`, details: {} })
  })
  return {
    send(value) {
      if (closed || ended) return
      const item = { type: 'item' as const, value }
      if (opened && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ streamId, ...item }))
      else pending.push(item)
    },
    end() {
      if (closed || ended) return
      if (opened && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'end', streamId }))
      else pending.push({ type: 'end' })
    },
    close() {
      if (closed) return
      closed = true
      clearTimeout(openTimer)
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId }))
      socket.close()
      finish()
    },
  }
}

type MuxClientMessage =
  | { type: 'open'; streamId: string; endpoint: string; payload: unknown }
  | { type: 'item'; streamId: string; value?: unknown }
  | { type: 'end'; streamId: string }
  | { type: 'cancel'; streamId: string }

function muxClientMessage(data: RawData): MuxClientMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(data.toString()) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(value) || typeof value.streamId !== 'string' || value.streamId === '') return undefined
  if (value.type === 'cancel' && Object.keys(value).length === 2) {
    return { type: 'cancel', streamId: value.streamId }
  }
  if (value.type === 'end' && Object.keys(value).length === 2) {
    return { type: 'end', streamId: value.streamId }
  }
  if (value.type === 'item' && Object.keys(value).length <= 3) {
    return { type: 'item', streamId: value.streamId, ...Object.hasOwn(value, 'value') ? { value: value.value } : {} }
  }
  if (value.type === 'open'
    && typeof value.endpoint === 'string'
    && value.endpoint !== ''
    && Object.hasOwn(value, 'payload')) {
    return { type: 'open', streamId: value.streamId, endpoint: value.endpoint, payload: value.payload }
  }
  return undefined
}

function sendMuxItem(client: WebSocket, streamId: string, value: unknown): void {
  if (client.readyState !== WebSocket.OPEN) return
  client.send(JSON.stringify(value === undefined
    ? { type: 'item', streamId }
    : { type: 'item', streamId, value }))
}

function sendMuxError(client: WebSocket, streamId: string, error: RemoteStreamFailure): void {
  if (client.readyState !== WebSocket.OPEN) return
  client.send(JSON.stringify({ type: 'error', streamId, error }))
}

function sendMuxEnd(client: WebSocket, streamId: string): void {
  if (client.readyState !== WebSocket.OPEN) return
  client.send(JSON.stringify({ type: 'end', streamId }))
}

function addTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> {
  return setTimeout(callback, milliseconds)
}

function workspaceValue(value: unknown, target: FleetNativeTarget): unknown {
  const transformed = peerResponseValue(value, target.id)
  if (!isRecord(transformed) || typeof transformed.title !== 'string') return transformed
  return { ...transformed, title: repositoryTitle(target.repository, transformed.title) }
}

function aggregateWorkspaceStream(
  client: WebSocket,
  streamId: string,
  targets: readonly FleetNativeTarget[],
  warn: (message: string) => void,
  onClosed: () => void,
): UpstreamStream {
  interface PeerState {
    views: unknown[]
    archived: unknown[]
    pinned: unknown[]
    order: string[]
    baseline: boolean
    ended: boolean
  }
  const peers = new Map<string, PeerState>(targets.map(target => [target.id, {
    views: [], archived: [], pinned: [], order: [], baseline: false, ended: false,
  }]))
  const handles: UpstreamStream[] = []
  let ready = false
  let closed = false
  const timer = addTimeout(() => { flush() }, STREAM_BASELINE_TIMEOUT_MS)
  const unique = (values: readonly unknown[]): unknown[] => [...new Set(values)]
  const items = (): unknown[] => targets.flatMap(target => {
    const peer = peers.get(target.id)!
    const rank = new Map(peer.order.map((id, index) => [id, index]))
    return [...peer.views].sort((left, right) => {
      const leftId = isRecord(left) && typeof left.workspaceId === 'string' ? left.workspaceId : ''
      const rightId = isRecord(right) && typeof right.workspaceId === 'string' ? right.workspaceId : ''
      return (rank.get(leftId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(rightId) ?? Number.MAX_SAFE_INTEGER)
    })
  })
  const archived = (): unknown[] => unique(targets.flatMap(target => peers.get(target.id)?.archived ?? []))
  const pinned = (): unknown[] => unique(targets.flatMap(target => peers.get(target.id)?.pinned ?? []))
  const baselineValue = (): Record<string, unknown> => ({
    items: items(),
    archivedSessionIds: archived(),
    pinnedSessionIds: pinned(),
  })
  const workspaceIds = (): string[] => items().flatMap(item =>
    isRecord(item) && typeof item.workspaceId === 'string' ? [item.workspaceId] : [])
  const run = (operation: () => void): void => {
    if (ready && !closed) operation()
  }
  const applyBaseline = (target: FleetNativeTarget, value: unknown): void => {
    const peer = peers.get(target.id)!
    const raw = isRecord(value) ? value : {}
    peer.views = Array.isArray(raw.items)
      ? raw.items.filter(item => !isRecord(item) || !deploymentOwnedPath(target, item.path, targets))
        .map(item => workspaceValue(item, target))
      : []
    peer.order = peer.views.flatMap(item =>
      isRecord(item) && typeof item.workspaceId === 'string' ? [item.workspaceId] : [])
    peer.archived = Array.isArray(raw.archivedSessionIds)
      ? raw.archivedSessionIds.map(item => typeof item === 'string' ? nativeSessionId(target.id, item) : item)
      : []
    peer.pinned = Array.isArray(raw.pinnedSessionIds)
      ? raw.pinnedSessionIds.map(item => typeof item === 'string' ? nativeSessionId(target.id, item) : item)
      : []
    peer.baseline = true
  }
  const flush = (): void => {
    if (ready || closed) return
    const available = targets.some(target => peers.get(target.id)?.baseline === true)
    if (!available) {
      sendMuxError(client, streamId, {
        code: 'gateway/service-unavailable',
        message: 'No deployment is available for Workspace state',
        details: {},
      })
      sendMuxEnd(client, streamId)
      close()
      return
    }
    clearTimeout(timer)
    ready = true
    sendMuxItem(client, streamId, { type: 'baseline', value: baselineValue() })
  }
  const maybeFlush = (): void => {
    if (targets.every(target => peers.get(target.id)?.baseline || peers.get(target.id)?.ended)) flush()
  }
  const maybeEnd = (): void => {
    if (!closed && ready && targets.every(target => peers.get(target.id)?.ended)) {
      sendMuxEnd(client, streamId)
      close()
    }
  }

  for (const target of targets) {
    const peer = peers.get(target.id)!
    handles.push(openUpstreamStream(target, 'workspace/follow', { args: {} }, {
      onItem(value) {
        if (!isRecord(value) || typeof value.type !== 'string') return
        if ((value.type === 'baseline' || value.type === 'replace') && isRecord(value.value)) {
          applyBaseline(target, value.value)
          if (ready) run(() => sendMuxItem(client, streamId, { type: 'replace', value: baselineValue() }))
          else maybeFlush()
          return
        }
        if (!peer.baseline) return
        if (value.type === 'upsert' && isRecord(value.workspace) && typeof value.workspace.workspaceId === 'string') {
          if (deploymentOwnedPath(target, value.workspace.path, targets)) return
          const workspace = workspaceValue(value.workspace, target)
          const id = (workspace as { workspaceId: string }).workspaceId
          const index = peer.views.findIndex(item => isRecord(item) && item.workspaceId === id)
          if (index === -1) peer.views.unshift(workspace)
          else peer.views[index] = workspace
          run(() => sendMuxItem(client, streamId, { type: 'upsert', workspace }))
          return
        }
        if (value.type === 'remove' && typeof value.workspaceId === 'string') {
          const workspaceId = nativeWorkspaceId(target.id, value.workspaceId)
          const index = peer.views.findIndex(item => isRecord(item) && item.workspaceId === workspaceId)
          if (index === -1) return
          peer.views.splice(index, 1)
          run(() => sendMuxItem(client, streamId, { type: 'remove', workspaceId }))
          return
        }
        if (value.type === 'order' && Array.isArray(value.workspaceIds)) {
          peer.order = value.workspaceIds.map(id => typeof id === 'string' ? nativeWorkspaceId(target.id, id) : String(id))
          run(() => sendMuxItem(client, streamId, { type: 'order', workspaceIds: workspaceIds() }))
          return
        }
        if (value.type === 'archived' && Array.isArray(value.archivedSessionIds)) {
          peer.archived = value.archivedSessionIds.map(id =>
            typeof id === 'string' ? nativeSessionId(target.id, id) : id)
          run(() => sendMuxItem(client, streamId, { type: 'archived', archivedSessionIds: archived() }))
          return
        }
        if (value.type === 'pinned' && Array.isArray(value.pinnedSessionIds)) {
          peer.pinned = value.pinnedSessionIds.map(id =>
            typeof id === 'string' ? nativeSessionId(target.id, id) : id)
          run(() => sendMuxItem(client, streamId, { type: 'pinned', pinnedSessionIds: pinned() }))
        }
      },
      onError(error) {
        peer.ended = true
        warn(`Workspace stream for ${peerLabel(target)} ended: ${error.message}`)
        maybeFlush()
        maybeEnd()
      },
      onEnd() {
        peer.ended = true
        maybeFlush()
        maybeEnd()
      },
    }))
  }

  function close(): void {
    if (closed) return
    closed = true
    clearTimeout(timer)
    for (const handle of handles) handle.close()
    onClosed()
  }
  return {
    send() {},
    end() {},
    close,
  }
}

function mergeControlBaselines(values: readonly unknown[]): { projections: Record<string, unknown> } {
  const projections: Record<string, unknown> = {}
  for (const value of values) {
    if (!isRecord(value)) continue
    if (isRecord(value.projections)) Object.assign(projections, value.projections)
  }
  return { projections }
}

function aggregateControlStream(
  client: WebSocket,
  streamId: string,
  targets: readonly FleetNativeTarget[],
  warn: (message: string) => void,
  onClosed: () => void,
): UpstreamStream {
  const baselines = new Map<string, unknown>()
  const ended = new Set<string>()
  const pending: (() => void)[] = []
  const handles: UpstreamStream[] = []
  let ready = false
  let closed = false
  const timer = addTimeout(() => { flush() }, STREAM_BASELINE_TIMEOUT_MS)
  const run = (operation: () => void): void => {
    if (!ready) pending.push(operation)
    else if (!closed) operation()
  }
  const flush = (): void => {
    if (ready || closed) return
    if (baselines.size === 0) {
      sendMuxError(client, streamId, {
        code: 'gateway/service-unavailable',
        message: 'No deployment is available for Session control state',
        details: {},
      })
      sendMuxEnd(client, streamId)
      close()
      return
    }
    clearTimeout(timer)
    ready = true
    sendMuxItem(client, streamId, { type: 'baseline', value: mergeControlBaselines([...baselines.values()]) })
    for (const operation of pending.splice(0)) operation()
  }
  const maybeFlush = (): void => {
    if (targets.every(target => baselines.has(target.id) || ended.has(target.id))) flush()
  }
  const maybeEnd = (): void => {
    if (!closed && ready && targets.every(target => ended.has(target.id))) {
      sendMuxEnd(client, streamId)
      close()
    }
  }
  const sendLateBaseline = (baseline: unknown): void => {
    if (!isRecord(baseline) || !isRecord(baseline.projections)) return
    for (const [sessionId, value] of Object.entries(baseline.projections)) {
      if (!isRecord(value) || !isRecord(value.values)) continue
      for (const [key, projection] of Object.entries(value.values)) {
        sendMuxItem(client, streamId, {
          type: 'projection',
          sessionId,
          key,
          value: projection,
          seq: typeof value.asOfSeq === 'number' ? value.asOfSeq : 0,
        })
      }
    }
  }

  for (const target of targets) {
    handles.push(openUpstreamStream(target, 'session/control', { args: {} }, {
      onItem(value) {
        if (!isRecord(value)) return
        const transformed = peerSessionControlValue(value, target)
        if (!isRecord(transformed)) return
        if (transformed.type === 'baseline' && isRecord(transformed.value)) {
          const late = ready
          baselines.set(target.id, transformed.value)
          if (late) sendLateBaseline(transformed.value)
          maybeFlush()
          return
        }
        const operation = (): void => { sendMuxItem(client, streamId, transformed) }
        run(operation)
      },
      onError(error) {
        ended.add(target.id)
        warn(`Session control stream for ${peerLabel(target)} ended: ${error.message}`)
        maybeFlush()
        maybeEnd()
      },
      onEnd() {
        ended.add(target.id)
        maybeFlush()
        maybeEnd()
      },
    }))
  }

  function close(): void {
    if (closed) return
    closed = true
    clearTimeout(timer)
    for (const handle of handles) handle.close()
    onClosed()
  }
  return { send() {}, end() {}, close }
}

const SESSION_EVENTS = new Set([
  'agent-preset/selected',
  'api-session/activity',
  'api-session/added',
  'api-session/error',
  'api-session/removed',
  'api-session/status',
  'approval/request',
  'user-questions/request',
])

function eventArgs(target: FleetNativeTarget, event: string, args: unknown): unknown[] {
  if (!Array.isArray(args)) return []
  if (event === 'api-session/added') return [peerResponseValue(args[0], target.id), ...args.slice(1)]
  if ((event === 'agent-preset/selected' || event.startsWith('api-session/')) && typeof args[0] === 'string') {
    return [nativeSessionId(target.id, args[0]), ...args.slice(1)]
  }
  return args.map(value => peerResponseValue(value, target.id))
}

function aggregateEventsStream(
  client: WebSocket,
  streamId: string,
  targets: readonly FleetNativeTarget[],
  state: NativeControllerState,
  warn: (message: string) => void,
  onClosed: () => void,
): UpstreamStream {
  const controllerClientId = `dsh-superagent.events.${randomUUID()}`
  const handles: UpstreamStream[] = []
  const localClientIds = new Map<string, string>()
  const ended = new Set<string>()
  let closed = false
  sendMuxItem(client, streamId, {
    type: 'ready',
    clientId: controllerClientId,
    host: { home: process.env.HOME ?? '' },
  })
  const maybeEnd = (): void => {
    if (!closed && targets.every(target => ended.has(target.id))) {
      sendMuxError(client, streamId, {
        code: 'gateway/service-unavailable',
        message: 'No deployment Remote event stream is available',
        details: {},
      })
      sendMuxEnd(client, streamId)
      close()
    }
  }

  for (const target of targets) {
    handles.push(openUpstreamStream(target, '$events', { args: {} }, {
      onItem(value) {
        if (!isRecord(value) || typeof value.type !== 'string') return
        if (value.type === 'ready') {
          if (typeof value.clientId === 'string') {
            localClientIds.set(target.id, value.clientId)
            bindEventClient(state, target.id, controllerClientId, value.clientId)
          }
          return
        }
        if (value.type === 'emit') {
          if (typeof value.event !== 'string') return
          const isSessionEvent = SESSION_EVENTS.has(value.event)
          if (!isSessionEvent && target.id !== LOCAL_TARGET_ID) return
          sendMuxItem(client, streamId, {
            ...value,
            args: eventArgs(target, value.event, value.args),
          })
          return
        }
        if (value.type === 'waterfall' && typeof value.event === 'string' && typeof value.eventId === 'string') {
          sendMuxItem(client, streamId, {
            ...value,
            eventId: nativeEventId(target.id, value.eventId),
            ...Array.isArray(value.args) ? { args: eventArgs(target, value.event, value.args) } : {},
            ...typeof value.agentId === 'string' ? { agentId: nativeSessionId(target.id, value.agentId) } : {},
            request: peerResponseValue(value.request, target.id),
          })
          return
        }
        if (value.type === 'cancel' && typeof value.eventId === 'string') {
          sendMuxItem(client, streamId, { ...value, eventId: nativeEventId(target.id, value.eventId) })
        }
      },
      onError(error) {
        ended.add(target.id)
        unbindEventClient(state, target.id, controllerClientId)
        warn(`Session event stream for ${peerLabel(target)} ended: ${error.message}`)
        maybeEnd()
      },
      onEnd() {
        ended.add(target.id)
        unbindEventClient(state, target.id, controllerClientId)
        maybeEnd()
      },
    }))
  }

  function close(): void {
    if (closed) return
    closed = true
    for (const targetId of localClientIds.keys()) unbindEventClient(state, targetId, controllerClientId)
    for (const handle of handles) handle.close()
    onClosed()
  }
  return { send() {}, end() {}, close }
}

function controllerUpgrade(ctx: Context, stateDir: string, server: WebSocketServer, state: NativeControllerState) {
  const fleet = new Fleet(stateDir)
  return (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (ctx.connection.requestRejection(request) !== undefined) {
      socket.destroy()
      return
    }
    acceptUpgrade(server, request, socket, head, (client) => {
      interface Route {
        stream: UpstreamStream
        target?: FleetNativeTarget
        endpoint: string
      }
      const routes = new Map<string, Route>()
      const remove = (streamId: string, route: Route): void => {
        if (routes.get(streamId) === route) routes.delete(streamId)
      }
      const warn = (message: string): void => { ctx.logger.warn(redactSensitive(message)) }
      client.on('message', data => {
        const message = muxClientMessage(data)
        if (message === undefined) {
          client.close(1003, 'Invalid Remote mux frame')
          return
        }
        if (message.type === 'cancel') {
          routes.get(message.streamId)?.stream.close()
          return
        }
        if (message.type === 'item') {
          const route = routes.get(message.streamId)
          if (route?.target !== undefined) {
            route.stream.send(outboundPeerPayload(route.target, route.endpoint, message.value))
          }
          return
        }
        if (message.type === 'end') {
          routes.get(message.streamId)?.stream.end()
          return
        }
        if (routes.has(message.streamId)) {
          sendMuxError(client, message.streamId, {
            code: 'gateway/protocol',
            message: 'Remote stream id is already open',
            details: {},
          })
          sendMuxEnd(client, message.streamId)
          return
        }

        let targets: FleetNativeTarget[]
        let fallback: FleetNativeTarget
        try {
          fallback = localTarget(ctx, stateDir)
          targets = [fallback, ...fleet.nativeTargets()]
        } catch (error) {
          sendMuxError(client, message.streamId, {
            code: 'gateway/service-unavailable',
            message: redactSensitive(error instanceof Error ? error.message : String(error)),
            details: {},
          })
          sendMuxEnd(client, message.streamId)
          return
        }

        let route: Route | undefined
        const closed = (): void => {
          if (route !== undefined) remove(message.streamId, route)
        }
        if (message.endpoint === 'workspace/follow') {
          route = { endpoint: message.endpoint, stream: aggregateWorkspaceStream(client, message.streamId, targets, warn, closed) }
        } else if (message.endpoint === 'session/control') {
          route = { endpoint: message.endpoint, stream: aggregateControlStream(client, message.streamId, targets, warn, closed) }
        } else if (message.endpoint === '$events') {
          route = {
            endpoint: message.endpoint,
            stream: aggregateEventsStream(client, message.streamId, targets, state, warn, closed),
          }
        } else {
          let target: FleetNativeTarget
          try {
            target = requestOwner(message.payload, targets, fallback)
          } catch (error) {
            sendMuxError(client, message.streamId, {
              code: 'gateway/bad-request',
              message: redactSensitive(error instanceof Error ? error.message : String(error)),
              details: {},
            })
            sendMuxEnd(client, message.streamId)
            return
          }
          const pending: Route = {
            endpoint: message.endpoint,
            target,
            stream: undefined as unknown as UpstreamStream,
          }
          pending.stream = openUpstreamStream(
            target,
            message.endpoint,
            outboundPeerPayload(target, message.endpoint, message.payload),
            {
              onItem(value) { sendMuxItem(client, message.streamId, responseValue(target, message.endpoint, value)) },
              onError(error) {
                sendMuxError(client, message.streamId, {
                  ...error,
                  message: redactSensitive(error.message),
                  details: peerResponseValue(error.details, target.id) as Record<string, unknown>,
                })
                sendMuxEnd(client, message.streamId)
                remove(message.streamId, pending)
              },
              onEnd() {
                sendMuxEnd(client, message.streamId)
                remove(message.streamId, pending)
              },
            },
          )
          route = pending
        }
        routes.set(message.streamId, route)
      })
      client.on('close', () => {
        for (const route of [...routes.values()]) route.stream.close()
        routes.clear()
      })
      client.on('error', () => {
        for (const route of [...routes.values()]) route.stream.close()
        routes.clear()
      })
    })
  }
}

function repositoryAuth(ctx: Context) {
  const mint = async (interactions: 'none' | 'answer'): Promise<string> => {
    const base = `http://127.0.0.1:${ctx.webServer.port}`
    const login = new URL(ctx.connection.authenticatedUrl(base))
    const operatorPeers = typeof (ctx.connection as { admit?: unknown }).admit === 'function'
    if (operatorPeers) {
      login.pathname = '/connect'
      login.searchParams.set('interactions', interactions)
    }
    const response = await fetch(login, { redirect: 'manual' })
    const value = response.headers.get('set-cookie')?.split(';', 1)[0]
    await response.body?.cancel()
    if (![302, 303].includes(response.status) || value === undefined || value === '') {
      throw new Error(`native Session proxy authentication returned ${response.status}`)
    }
    return value
  }
  let httpCookie: Promise<string> | undefined
  return {
    http: (): Promise<string> => {
      httpCookie ??= mint('none').catch(error => {
        httpCookie = undefined
        throw error
      })
      return httpCookie
    },
    mux: (): Promise<string> => mint('answer'),
  }
}

function repositoryUpgrade(ctx: Context, stateDir: string, server: WebSocketServer, auth: ReturnType<typeof repositoryAuth>) {
  return (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!internalRequest(request, ctx.webServer.port, stateDir)) {
      socket.destroy()
      return
    }
    acceptUpgrade(server, request, socket, head, (client) => {
      const early: { data: RawData; binary: boolean }[] = []
      const hold = (data: RawData, binary: boolean): void => { early.push({ data, binary }) }
      client.on('message', hold)
      void auth.mux().then(value => {
        const base = `http://127.0.0.1:${ctx.webServer.port}`
        const upstream = new WebSocket(webSocketUrl(base, '/api/remote.mux'), {
          headers: { cookie: value, origin: base, 'sec-fetch-site': 'same-origin' },
        })
        client.off('message', hold)
        relaySockets(client, upstream, early)
      }, (error: unknown) => {
        client.off('message', hold)
        ctx.logger.warn('native Session proxy authentication failed: %s', redactSensitive(error instanceof Error ? error.message : String(error)))
        client.close(1011, 'Deployment authentication failed')
      })
    })
  }
}

function repositoryHttp(
  ctx: Context,
  stateDir: string,
  auth: ReturnType<typeof repositoryAuth>,
  local: Record<string, string> = {},
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!internalRequest(request, ctx.webServer.port, stateDir)) {
      response.writeHead(403)
      response.end()
      return
    }
    const source = new URL(request.url ?? '/', 'http://dsh.internal')
    const suffix = source.pathname.slice(NATIVE_API.length)
    const base = `http://127.0.0.1:${ctx.webServer.port}`
    const target = new URL(`/api${suffix}`, base)
    target.search = source.search
    try {
      await proxyHttp(request, response, target, {
        host: `127.0.0.1:${ctx.webServer.port}`,
        origin: base,
        cookie: await auth.http(),
        'sec-fetch-site': 'same-origin',
        ...local,
      })
    } catch (error) {
      const message = redactSensitive(error instanceof Error ? error.message : String(error))
      ctx.logger.warn('native Session proxy request failed for %s: %s', target.pathname, message)
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      if (!response.writableEnded) response.end(`Deployment authentication failed: ${message}`)
    }
  }
}

function controlHttp(ctx: Context, stateDir: string, state: NativeControllerState, localNonce: string) {
  const fleet = new Fleet(stateDir)
  return async (request: IncomingMessage, response: ServerResponse, next: () => Promise<void>): Promise<void> => {
    if (request.url !== '/api' && !request.url?.startsWith('/api/') && !request.url?.startsWith('/api?')) {
      await next()
      return
    }
    // The Desktop's own peer route reaches this profile's API; only this process knows the marker.
    if (request.headers[LOCAL_HEADER] === localNonce) {
      await next()
      return
    }
    let targets: FleetNativeTarget[]
    let fallback: FleetNativeTarget
    try {
      fallback = localTarget(ctx, stateDir)
      targets = [fallback, ...fleet.nativeTargets()]
    } catch (error) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(redactSensitive(error instanceof Error ? error.message : String(error)))
      return
    }
    const source = new URL(request.url ?? '/', 'http://dsh.internal')
    const json = request.method === 'POST'
      && request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
    // Non-RPC API traffic (settings, files, attachments) names no Session, so it is the Desktop profile's own.
    if (!json) {
      await next()
      return
    }

    let body: Buffer
    try {
      body = await readRequestBody(request)
    } catch (error) {
      response.writeHead(error instanceof RangeError ? 413 : 400, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(redactSensitive(error instanceof Error ? error.message : String(error)))
      return
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(body.toString('utf8')) as unknown
    } catch {
      decoded = undefined
    }
    const envelope = clientEnvelope(decoded)
    if (envelope === undefined) {
      const proxied = new URL(`/orchestrator/native${source.pathname}`, fallback.url)
      proxied.search = source.search
      try {
        await proxyBufferedHttp(request, response, proxied, body, nativeHeaders(fallback))
      } catch (error) {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        if (!response.writableEnded) {
          response.end(redactSensitive(`Deployment unavailable: ${error instanceof Error ? error.message : String(error)}`))
        }
      }
      return
    }

    const abort = abortOnDisconnect(response)
    try {
      const result = await aggregateRpc(targets, source.pathname, envelope, fallback, state, abort.signal)
      writeJson(response, 200, result)
    } catch (error) {
      if (!response.headersSent) writeJson(response, 502, aggregateFailure(
        envelope.rpcId,
        redactSensitive(`Deployment unavailable: ${error instanceof Error ? error.message : String(error)}`),
      ))
      else if (!response.writableEnded) response.end()
    }
  }
}

/**
 * Register the controller or repository half of native DSH Session routing.
 * @param ctx - Host context with Connection and Web server services.
 * @param stateDir - Controller registry directory.
 * @param role - Control process or repository-bound deployment process.
 * @returns Disposer restoring every route and interceptor.
 */
export function registerNativeTransport(ctx: Context, stateDir: string, role: NativeRole): () => void {
  if (!isLoopbackHost(ctx.webServer.host)) throw new Error('Native Session routing requires a loopback Web server')
  const server = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  const disposers: (() => void)[] = []
  if (role === 'control') {
    const state: NativeControllerState = { eventClients: new Map() }
    const auth = repositoryAuth(ctx)
    const localNonce = randomBytes(32).toString('base64url')
    const control = controllerUpgrade(ctx, stateDir, server, state)
    const local = repositoryUpgrade(ctx, stateDir, server, auth)
    disposers.push(ctx.on('connection/request', controlHttp(ctx, stateDir, state, localNonce)))
    disposers.push(ctx.webServer.register({
      kind: 'prefix',
      path: NATIVE_API,
      handler: repositoryHttp(ctx, stateDir, auth, { [LOCAL_HEADER]: localNonce }),
    }))
    disposers.push(ctx.webServer.registerUpgrade({
      path: NATIVE_MUX,
      handler: (request, socket, head) => {
        if (internalRequest(request, ctx.webServer.port, stateDir)) local(request, socket, head)
        else control(request, socket, head)
      },
    }))
  } else {
    const auth = repositoryAuth(ctx)
    disposers.push(ctx.webServer.register({ kind: 'prefix', path: NATIVE_API, handler: repositoryHttp(ctx, stateDir, auth) }))
    disposers.push(ctx.webServer.registerUpgrade({
      path: NATIVE_MUX,
      handler: repositoryUpgrade(ctx, stateDir, server, auth),
    }))
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
    for (const client of server.clients) client.terminate()
    server.close()
  }
}
