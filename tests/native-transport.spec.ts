// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import {
  installDesktopNativeTransport,
  isDesktopShell,
  nativeRemoteMuxUrl,
  reconnectDesktopConnection,
} from '../src/client/native-transport.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
})

it('routes the Desktop Remote mux through the controller without changing other sockets', () => {
  expect(nativeRemoteMuxUrl('ws://127.0.0.1:62478/api/remote.mux'))
    .toBe('ws://127.0.0.1:62478/orchestrator/native/remote.mux')
  expect(nativeRemoteMuxUrl('ws://127.0.0.1:62478/events'))
    .toBe('ws://127.0.0.1:62478/events')
})

it('replaces only the Desktop WebSocket constructor while installed', () => {
  const original = vi.fn()
  vi.stubGlobal('WebSocket', original)
  const restore = installDesktopNativeTransport()
  expect(globalThis.WebSocket).not.toBe(original)
  new globalThis.WebSocket('ws://127.0.0.1:62478/api/remote.mux')
  expect(original).toHaveBeenCalledWith('ws://127.0.0.1:62478/orchestrator/native/remote.mux')
  restore()
  expect(globalThis.WebSocket).toBe(original)
})

it('recognizes the packaged desktop transport that supplies only a stream base URL', () => {
  vi.stubGlobal('location', { protocol: 'dsh-app:' })
  ;(globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ = {
    streamBaseUrl: 'ws://127.0.0.1:61479',
  }
  expect(isDesktopShell()).toBe(true)
  expect(isDesktopShell.call(undefined)).toBe(true)
  ;(globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ = {}
  expect(isDesktopShell()).toBe(false)
  vi.stubGlobal('location', { protocol: 'https:' })
  expect(isDesktopShell()).toBe(false)
})

it('reconnects once after the shared Desktop connection generation is ready', () => {
  let generation: { id: number; host: { home: string } } | undefined
  let notify: (() => void) | undefined
  const unsubscribe = vi.fn()
  const reconnect = vi.fn()
  const connection = {
    generation: {
      getSnapshot: () => generation,
      subscribe: (listener: () => void) => {
        notify = listener
        return unsubscribe
      },
    },
    reconnect,
  }
  const dispose = reconnectDesktopConnection(connection)
  expect(reconnect).not.toHaveBeenCalled()

  generation = { id: 1, host: { home: '/Users/test' } }
  notify?.()
  expect(reconnect).toHaveBeenCalledOnce()

  generation = { id: 2, host: { home: '/Users/test' } }
  notify?.()
  expect(reconnect).toHaveBeenCalledOnce()

  dispose()
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('reconnects immediately when the connection generation is already ready', () => {
  const reconnect = vi.fn()
  reconnectDesktopConnection({
    generation: {
      getSnapshot: () => ({ id: 1, host: { home: '/Users/test' } }),
      subscribe: () => vi.fn(),
    },
    reconnect,
  })()
  expect(reconnect).toHaveBeenCalledOnce()
})
