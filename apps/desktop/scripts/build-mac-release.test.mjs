import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
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
