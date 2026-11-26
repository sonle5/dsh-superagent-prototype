/** Shared loopback capability used between the Desktop controller and one deployment. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN_FILE = 'native-proxy-token'
const TOKEN = /^[A-Za-z0-9_-]{43}$/

function tokenPath(stateDir: string): string {
  return join(stateDir, TOKEN_FILE)
}

/** Read or create the deployment's native-proxy capability. */
export function nativeToken(stateDir: string, create = true): string | undefined {
  const path = tokenPath(stateDir)
  try {
    const value = readFileSync(path, 'utf8').trim()
    if (!TOKEN.test(value)) throw new Error(`Invalid native proxy credential at ${path}`)
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!create) return undefined
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const value = randomBytes(32).toString('base64url')
  try {
    writeFileSync(path, `${value}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return nativeToken(stateDir, false)
  }
}

/**
 * Sign-in rejection for a browser request on DSH hosts that predate route `auth`. Hosts without
 * `Connection.requestRejection` enforce the route rule before calling the handler, so this returns undefined there.
 * @param connection - The host Connection service.
 * @param request - Request headers to check.
 * @returns 401 or 403 when a legacy host refuses the request, otherwise undefined.
 */
export function legacyRequestRejection<R>(
  connection: { readonly requestRejection?: (request: R) => 401 | 403 | undefined },
  request: R,
): 401 | 403 | undefined {
  return typeof connection.requestRejection === 'function' ? connection.requestRejection(request) : undefined
}

/** Compare one presented controller capability without exposing token contents. */
export function matchesNativeToken(stateDir: string, presented: string | string[] | undefined): boolean {
  if (typeof presented !== 'string') return false
  const expected = nativeToken(stateDir, false)
  if (expected === undefined) return false
  const actual = Buffer.from(presented)
  const wanted = Buffer.from(expected)
  return actual.byteLength === wanted.byteLength && timingSafeEqual(actual, wanted)
}
