import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
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

it('installs renewed certificates and restarts the gateway', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tls-hook-'))
  try {
    const bin = join(root, 'bin')
    const tls = join(root, 'tls')
    const marker = join(root, 'reloaded')
    mkdirSync(bin)
    writeFileSync(join(root, 'fullchain.pem'), 'certificate')
    writeFileSync(join(root, 'privkey.pem'), 'private key')
    writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nprintf "%s" "$*" > "$RELOAD_MARKER"\n')
    chmodSync(join(bin, 'systemctl'), 0o755)
    const envFile = join(root, 'tls.env')
    const group = spawnSync('id', ['-gn'], { encoding: 'utf8' }).stdout.trim()
    writeFileSync(envFile, [
      `DSH_TLS_CERT_SOURCE=${join(root, 'fullchain.pem')}`,
      `DSH_TLS_KEY_SOURCE=${join(root, 'privkey.pem')}`,
      `DSH_TLS_OWNER=${process.getuid?.() === 0 ? 'root' : process.env.USER}`,
      `DSH_TLS_GROUP=${process.getuid?.() === 0 ? 'root' : group}`,
      `DSH_TLS_GATEWAY_UNIT=test-gateway.service`,
      `DSH_TLS_DIR=${tls}`,
    ].join('\n'))
    const hook = join(import.meta.dirname, '..', 'examples', 'cloud', 'letsencrypt', 'reload-gateway.sh')
    const result = spawnSync(hook, [], {
      env: { ...process.env, DSH_SUPERAGENT_TLS_ENV: envFile, PATH: `${bin}:${process.env.PATH}`, RELOAD_MARKER: marker },
    })
    expect(result.status, result.stderr.toString()).toBe(0)
    expect(readFileSync(join(tls, 'cert.pem'), 'utf8')).toBe('certificate')
    expect(readFileSync(join(tls, 'key.pem'), 'utf8')).toBe('private key')
    expect(statSync(join(tls, 'cert.pem')).mode & 0o777).toBe(0o640)
    expect(statSync(join(tls, 'key.pem')).mode & 0o777).toBe(0o640)
    expect(readFileSync(marker, 'utf8')).toBe('restart test-gateway.service')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
