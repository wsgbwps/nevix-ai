import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signingInputs } from './build-mac-release.mjs'

test('formal Mac signing refuses missing or ad-hoc identities without invoking a signer', () => {
  for (const environment of [
    {},
    { NEVIX_MAC_SIGNING_SHA1: '-' },
    { NEVIX_MAC_SIGNING_SHA1: 'a'.repeat(40) },
    { NEVIX_MAC_SIGNING_SHA1: 'invalid', NEVIX_MAC_SIGNING_KEYCHAIN: '/tmp/identity.keychain-db' }
  ])
    assert.throws(() => signingInputs(environment))
  assert.deepEqual(
    signingInputs({
      NEVIX_MAC_SIGNING_SHA1: 'a'.repeat(40),
      NEVIX_MAC_SIGNING_KEYCHAIN: './identity.keychain-db'
    }),
    { identity: 'A'.repeat(40), keychain: resolve('./identity.keychain-db') }
  )
})

import { assertSigningKeychainListed } from './build-mac-release.mjs'
test('formal signing requires the existing keychain in the current user search list', async () => {
  await assert.rejects(
    assertSigningKeychainListed(
      '/tmp/nevix-not-listed.keychain-db',
      '    "/tmp/other.keychain-db"\n'
    ),
    /user keychain search list/
  )
})

test('formal signer accepts the same already-listed keychain through a resolved alias', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nevix-keychain-preflight-'))
  try {
    const file = join(root, 'existing signing.keychain-db')
    const alias = join(root, 'alias.keychain-db')
    await writeFile(file, '')
    await symlink(file, alias)
    await assertSigningKeychainListed(alias, `    "${file}"\n`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
