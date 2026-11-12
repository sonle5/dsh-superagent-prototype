import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('does not copy the gateway web login token from stdout into the journal', () => {
  const unit = readFileSync(join(import.meta.dirname, '..', 'examples', 'cloud', 'systemd',
    'dsh-superagent-gateway.service'), 'utf8')
  expect(unit).toContain('StandardOutput=null')
  expect(unit).toContain('StandardError=journal')
})
