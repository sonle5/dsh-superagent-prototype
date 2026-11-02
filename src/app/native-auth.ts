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

/** Compare one presented controller capability without exposing token contents. */
export function matchesNativeToken(stateDir: string, presented: string | string[] | undefined): boolean {
  if (typeof presented !== 'string') return false
  const expected = nativeToken(stateDir, false)
  if (expected === undefined) return false
  const actual = Buffer.from(presented)
  const wanted = Buffer.from(expected)
  return actual.byteLength === wanted.byteLength && timingSafeEqual(actual, wanted)
}
