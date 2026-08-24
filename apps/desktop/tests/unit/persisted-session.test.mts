import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isDesktopSource = context.parentURL?.includes('/apps/desktop/src/') === true
    const resolvedSpecifier =
      isDesktopSource && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)
        ? `${specifier}.ts`
        : specifier
    return nextResolve(resolvedSpecifier, context)
  }
})

type InvokeCall = { readonly channel: string; readonly request?: unknown }

function installWindowApi(handler: (channel: string, request?: unknown) => Promise<unknown>): {
  readonly calls: InvokeCall[]
} {
  const calls: InvokeCall[] = []
  ;(globalThis as { window?: unknown }).window = {
    api: {
      invoke: (channel: string, request?: unknown) => {
        calls.push(request === undefined ? { channel } : { channel, request })
        return handler(channel, request)
      }
    }
  }
  return { calls }
}

const { createSessionPersistenceOverIpc } =
  await import('../../src/renderer/src/features/authentication/session/persisted-session.ts')

const credentials = {
  token: 'opaque-session-token',
  expiresAt: '2026-01-01T00:00:00Z',
  user: {
    id: 'user-1',
    email: 'admin@example.com',
    displayName: 'admin',
    role: 'admin',
    mustChangePassword: false
  }
}

const storedCredentials = { token: 'opaque-session-token', expiresAt: '2026-01-01T00:00:00Z' }

// The main process canonicalizes the stored form down to {id,email}; a write still
// carries the full account snapshot and the canonical strip happens on read.
const serializedCredentials = JSON.stringify({
  token: 'opaque-session-token',
  expires_at: '2026-01-01T00:00:00Z',
  user: { id: 'user-1', email: 'admin@example.com' }
})

const serializedFullCredentials = JSON.stringify({
  token: 'opaque-session-token',
  expires_at: '2026-01-01T00:00:00Z',
  user: {
    id: 'user-1',
    email: 'admin@example.com',
    display_name: 'admin',
    role: 'admin',
    must_change_password: false
  }
})

test.afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

test('reading a stored session yields the canonical credentials', async () => {
  const sessions = createSessionPersistenceOverIpc()
  installWindowApi(async (channel) => {
    if (channel === 'authentication:read-session') {
      return { outcome: 'session', session: serializedCredentials }
    }
    return undefined
  })

  assert.deepEqual(await sessions.read(), { outcome: 'stored', credentials: storedCredentials })
})

test('a session that is not the canonical schema is unreadable', async () => {
  const sessions = createSessionPersistenceOverIpc()
  installWindowApi(async () => ({ outcome: 'session', session: JSON.stringify({ token: 42 }) }))

  assert.deepEqual(await sessions.read(), { outcome: 'unreadable' })
})

test('a session missing its expiry is unreadable', async () => {
  const sessions = createSessionPersistenceOverIpc()
  installWindowApi(async () => ({
    outcome: 'session',
    session: JSON.stringify({ token: 'opaque-session-token' })
  }))

  assert.deepEqual(await sessions.read(), { outcome: 'unreadable' })
})

test('a Supabase-era session shape no longer restores', async () => {
  const sessions = createSessionPersistenceOverIpc()
  installWindowApi(async () => ({
    outcome: 'session',
    session: JSON.stringify({
      access_token: 'token',
      refresh_token: 'refresh',
      token_type: 'bearer',
      user: { id: 'user-1', email: 'admin@example.com' }
    })
  }))

  assert.deepEqual(await sessions.read(), { outcome: 'unreadable' })
})

test('an unreachable or reporting-unavailable store stays retryable', async () => {
  const sessions = createSessionPersistenceOverIpc()
  installWindowApi(async () => ({ outcome: 'storage-unavailable' }))
  assert.deepEqual(await sessions.read(), { outcome: 'unavailable' })

  installWindowApi(async () => {
    throw new Error('ipc failed')
  })
  assert.deepEqual(await sessions.read(), { outcome: 'unavailable' })
})

test('replacing credentials writes the canonical JSON through the encrypted IPC slot', async () => {
  const sessions = createSessionPersistenceOverIpc()
  const { calls } = installWindowApi(async () => ({ outcome: 'persisted' }))

  assert.deepEqual(await sessions.replace(credentials), { outcome: 'persisted' })
  assert.deepEqual(calls, [
    {
      channel: 'authentication:replace-session',
      request: { session: serializedFullCredentials }
    }
  ])
})

test('an unavailable or throwing secure store is reported, not silently swallowed', async () => {
  const sessions = createSessionPersistenceOverIpc()
  installWindowApi(async () => ({ outcome: 'unavailable' }))
  assert.deepEqual(await sessions.replace(credentials), { outcome: 'unavailable' })

  installWindowApi(async () => {
    throw new Error('ipc failed')
  })
  assert.deepEqual(await sessions.replace(credentials), { outcome: 'unavailable' })
})

test('clearing the slot reports whether the local credentials ended', async () => {
  const sessions = createSessionPersistenceOverIpc()
  const { calls } = installWindowApi(async () => undefined)
  assert.deepEqual(await sessions.clear(), { outcome: 'cleared' })
  assert.deepEqual(calls, [{ channel: 'authentication:clear-session' }])

  installWindowApi(async () => {
    throw new Error('ipc failed')
  })
  assert.deepEqual(await sessions.clear(), { outcome: 'clear-failed' })
})
