/** Desktop-only WebSocket routing for deployment-owned native DSH Sessions. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'

const REMOTE_MUX = '/api/remote.mux'
const CONTROLLER_MUX = '/orchestrator/native/remote.mux'

/**
 * Redirect the Gateway Remote multiplexer through the controller, leaving every other socket untouched.
 * @param value - URL passed to the browser WebSocket constructor.
 * @returns Controller-owned mux URL when the path is the DSH Remote mux.
 */
export function nativeRemoteMuxUrl(value: string): string {
  const url = new URL(value)
  if (url.pathname === REMOTE_MUX) url.pathname = CONTROLLER_MUX
  return url.href
}

/**
 * Replace the Desktop page's WebSocket constructor with one that routes only the Remote mux.
 * @returns Disposer restoring the previous constructor when this exact wrapper still owns it.
 */
export function installDesktopNativeTransport(): () => void {
  const Original = globalThis.WebSocket
  if (Original === undefined) return () => {}
  const Routed = function (url: string | URL, protocols?: string | string[]): WebSocket {
    const target = nativeRemoteMuxUrl(String(url))
    return protocols === undefined ? new Original(target) : new Original(target, protocols)
  } as unknown as typeof WebSocket
  Object.setPrototypeOf(Routed, Original)
  Routed.prototype = Original.prototype
  globalThis.WebSocket = Routed
  return () => {
    if (globalThis.WebSocket === Routed) globalThis.WebSocket = Original
  }
}

/**
 * Replace the Session's pre-plugin mux socket after the shared connection reaches its first generation.
 * @param connection - Desktop connection service whose socket carrier was created before this plugin loaded.
 * @returns Disposer cancelling the pending reconnect.
 */
export function reconnectDesktopConnection(
  connection: Pick<ConnectionHandle, 'generation' | 'reconnect'>,
): () => void {
  let active = true
  let reconnected = false
  const reconnect = (): void => {
    if (!active || reconnected || connection.generation.getSnapshot() === undefined) return
    reconnected = true
    connection.reconnect()
  }
  const unsubscribe = connection.generation.subscribe(reconnect)
  reconnect()
  return () => {
    active = false
    unsubscribe()
  }
}

/** Whether this page is the packaged Desktop shell rather than a deployment Web page. */
export function isDesktopShell(): boolean {
  return globalThis.location?.protocol === 'dsh-app:'
}
