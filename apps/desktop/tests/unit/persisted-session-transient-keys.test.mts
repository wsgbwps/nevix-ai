import assert from 'node:assert/strict'
import test from 'node:test'

// The adapter only touches window.api for access-token-bearing Session values.
const invocations: Array<{ channel: string; payload: unknown }> = []
;(globalThis as { window?: unknown }).window = {
  api: {
    invoke: async (channel: string, payload: unknown) => {
      invocations.push({ channel, payload })
      return channel === 'authentication:replace-session'
        ? { outcome: 'persisted' }
        : { outcome: 'empty' }
    }
  }
}

const { persistedSessionStorage, AUTHENTICATION_STORAGE_KEY, MAXIMUM_TRANSIENT_KEYS } =
  await import('../../src/renderer/src/features/authentication/session/persisted-session.ts')

test('the Session slot keeps non-Session values in memory without invoking Main', async () => {
  invocations.length = 0
  const verifier = JSON.stringify({ code_verifier: 'temporary-verifier' })

  await persistedSessionStorage.setItem(AUTHENTICATION_STORAGE_KEY, verifier)

  assert.equal(await persistedSessionStorage.getItem(AUTHENTICATION_STORAGE_KEY), verifier)
  assert.equal(invocations.length, 0)
})

test('the Session slot persists values with a non-empty access_token', async () => {
  invocations.length = 0
  const session = JSON.stringify({ access_token: 'access-token-marker' })

  await persistedSessionStorage.setItem(AUTHENTICATION_STORAGE_KEY, session)

  assert.deepEqual(invocations, [
    {
      channel: 'authentication:replace-session',
      payload: { session }
    }
  ])
})

test('a transient key round-trips within the bound and removeItem deletes it', async () => {
  await persistedSessionStorage.setItem('transient-roundtrip', 'verifier-value')
  assert.equal(await persistedSessionStorage.getItem('transient-roundtrip'), 'verifier-value')

  await persistedSessionStorage.removeItem('transient-roundtrip')
  assert.equal(await persistedSessionStorage.getItem('transient-roundtrip'), null)
})

test('the adapter never holds more than the fixed number of transient keys', async () => {
  assert.equal(typeof MAXIMUM_TRANSIENT_KEYS, 'number')
  const total = MAXIMUM_TRANSIENT_KEYS + 5

  for (let index = 0; index < total; index += 1) {
    await persistedSessionStorage.setItem(`flood-${index}`, `value-${index}`)
  }

  const retained: string[] = []
  for (let index = 0; index < total; index += 1) {
    if ((await persistedSessionStorage.getItem(`flood-${index}`)) !== null) {
      retained.push(`flood-${index}`)
    }
  }

  assert.equal(retained.length, MAXIMUM_TRANSIENT_KEYS)
  // The oldest writes are evicted first; the most recent writes survive.
  assert.equal(await persistedSessionStorage.getItem('flood-0'), null)
  assert.equal(await persistedSessionStorage.getItem(`flood-${total - 1}`), `value-${total - 1}`)
})

test('rewriting an existing transient key does not evict other keys', async () => {
  await persistedSessionStorage.setItem('flood-rewrite', 'initial')
  const survivor = `flood-${MAXIMUM_TRANSIENT_KEYS + 4}`

  await persistedSessionStorage.setItem('flood-rewrite', 'rewritten')

  assert.equal(await persistedSessionStorage.getItem('flood-rewrite'), 'rewritten')
  assert.equal(
    await persistedSessionStorage.getItem(survivor),
    `value-${MAXIMUM_TRANSIENT_KEYS + 4}`
  )
})
