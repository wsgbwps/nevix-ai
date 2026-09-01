import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const probe = join(dirname(fileURLToPath(import.meta.url)), '..', 'production-readiness', 'probe.mjs')

function run(args, env = {}) {
  return spawnSync(process.execPath, [probe, ...args], {
    encoding: 'utf8',
    env: { ...process.env, KAPON_API_KEY: '', ...env }
  })
}

test('the runner enumerates the embedded checklist without credentials', () => {
  const result = run(['--list'])
  assert.equal(result.status, 0)
  const slots = result.stdout.trim().split('\n')
  assert.ok(slots.length >= 30, `expected the full checklist, got ${slots.length} slots`)
  assert.ok(slots.every((line) => /^\S+\t\[(generation|inspection)\]\t/.test(line)))
})

test('the runner refuses to execute without an injected credential', () => {
  const result = run(['--slot', 'image.resolution.pro-2k'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /KAPON_API_KEY is not set/)
  // The refusal happens before any slot execution, so no evidence is written.
})

test('unknown slot ids are rejected instead of silently ignored', () => {
  const result = run(['--slot', 'image.resolution.8k'], { KAPON_API_KEY: 'fixture-key' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /unknown slot/)
})

test('executing an unimplemented probe fails loudly without recording evidence', () => {
  const result = run(['--slot', 'image.resolution.pro-2k'], { KAPON_API_KEY: 'fixture-key' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /T16 \(#166\)/)
  assert.match(result.stderr, /no evidence recorded/)
})
