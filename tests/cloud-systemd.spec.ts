import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('does not copy the gateway web login token from stdout into the journal', () => {
  const unit = readFileSync(join(import.meta.dirname, '..', 'examples', 'cloud', 'systemd',
    'dsh-superagent-gateway.service'), 'utf8')
  expect(unit).toContain('StandardOutput=null')
  expect(unit).toContain('StandardError=journal')
})

it('lets the unprivileged gateway bind TLS and run its fixed sudo helper', () => {
  const unit = readFileSync(join(import.meta.dirname, '..', 'examples', 'cloud', 'systemd',
    'dsh-superagent-gateway.service'), 'utf8')
  expect(unit).toContain('AmbientCapabilities=CAP_NET_BIND_SERVICE')
  expect(unit).toContain(
    'CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_SETUID CAP_SETGID CAP_CHOWN CAP_DAC_OVERRIDE')
})

it('does not tear down a recovered deployment when the recovery oneshot exits', () => {
  const unit = readFileSync(join(import.meta.dirname, '..', 'examples', 'cloud', 'systemd',
    'dsh-superagent-recover@.service'), 'utf8')
  expect(unit).toContain('KillMode=process')
})
