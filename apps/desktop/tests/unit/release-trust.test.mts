import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { verifyRelease } from '../../src/main/updater/release-trust.ts'
const vector = JSON.parse(
  await readFile(
    new URL('../../../../scripts/release-feasibility/vectors.json', import.meta.url),
    'utf8'
  )
)
test('a publisher signed candidate binds its exact platform and artifact', () => {
  assert.equal(verifyRelease(vector.envelope, vector.publicKey, 'win32', 'x64').version, '1.0.1')
  assert.throws(() => verifyRelease(vector.envelope, vector.publicKey, 'darwin', 'arm64'))
  assert.throws(() =>
    verifyRelease(
      { ...vector.envelope, payload: vector.envelope.payload.slice(1) },
      vector.publicKey,
      'win32',
      'x64'
    )
  )
})
import { checkForRelease } from '../../src/main/updater/release-trust.ts'
test('manual checking shows no update and refuses unknown or incompatible Server', async () => {
  const context = {
    currentVersion: '1.0.1',
    platform: 'win32',
    arch: 'x64',
    publicKeyPem: vector.publicKey,
    readRelease: async () => vector.envelope,
    readServer: async () => ({
      service: 'nevix-server',
      version: '1.0.0',
      min_desktop_version: '1.0.0'
    })
  }
  assert.deepEqual(await checkForRelease(context), { outcome: 'current' })
  assert.deepEqual(
    await checkForRelease({
      ...context,
      currentVersion: '1.0.0',
      readServer: async () => ({
        service: 'nevix-server',
        version: '0.9.0',
        min_desktop_version: '1.0.0'
      })
    }),
    { outcome: 'server-upgrade-required', minimum: '1.0.0' }
  )
  assert.deepEqual(
    await checkForRelease({
      ...context,
      readServer: async () => ({
        service: 'nevix-server',
        version: 'development',
        min_desktop_version: '1.0.0'
      })
    }),
    { outcome: 'server-unavailable' }
  )
})
import { createServer } from 'node:http'
import { readOfficialRelease } from '../../src/main/updater/official-source.ts'
test('controlled signed source delivers a visible candidate and malformed source is a failure', async () => {
  const server = createServer((_request, response) => response.end(JSON.stringify(vector.envelope)))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    const readRelease = (): Promise<unknown> =>
      readOfficialRelease('win32', 'x64', async (requested) => {
        assert.equal(
          requested,
          'https://cnb.cool/nevix.ai/nevix-releases/-/git/raw/main/stable/win32-x64.json'
        )
        return fetch(`http://127.0.0.1:${address.port}`)
      })
    const context = {
      currentVersion: '1.0.0',
      platform: 'win32',
      arch: 'x64',
      publicKeyPem: vector.publicKey,
      readRelease,
      readServer: async () => ({
        service: 'nevix-server',
        version: '1.0.0',
        min_desktop_version: '1.0.0'
      })
    }
    const result = await checkForRelease(context)
    assert.equal(result.outcome, 'available')
    assert.deepEqual(
      await checkForRelease({
        ...context,
        readRelease: async () => ({ ...vector.envelope, signature: 'A'.repeat(88) })
      }),
      { outcome: 'failed' }
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})
import { generateKeyPairSync, sign } from 'node:crypto'
test('signed ambiguous artifact URLs are rejected just like Go', () => {
  const keys = generateKeyPairSync('ed25519')
  const key = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  for (const url of [
    'https://@example.invalid/nevix.exe',
    'https://:@example.invalid/nevix.exe',
    'https://example.invalid/nevix%2Eexe',
    'https://example.invalid:65536/nevix.exe',
    'https:////example.invalid/nevix.exe',
    'https://example.invalid/bad%zz/nevix.exe',
    'https://%65xample.invalid/nevix.exe',
    'https://[fe80::1%25eth0]/nevix.exe'
  ]) {
    const bytes = Buffer.from(JSON.stringify({ ...vector.release, url }))
    const envelope = {
      format: 'nevix-release-v1',
      payload: bytes.toString('base64'),
      signature: sign(null, bytes, keys.privateKey).toString('base64')
    }
    assert.throws(() => verifyRelease(envelope, key, 'win32', 'x64'))
  }
})
