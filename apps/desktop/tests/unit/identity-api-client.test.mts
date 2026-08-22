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

const { createIdentityClient } =
  await import('../../src/renderer/src/features/authentication/api/client.ts')

const serverUrl = 'https://server.example'

async function withFetch<T>(implementation: typeof fetch, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = implementation
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

const loginSuccessBody = {
  token: 'opaque-session-token',
  expires_at: '2026-01-01T00:00:00Z',
  user: {
    id: 'user-1',
    email: 'admin@example.com',
    display_name: 'admin',
    role: 'admin',
    must_change_password: true
  }
}

test('login sends its credential JSON with the trusted-write discipline and parses the session', async () => {
  let callCount = 0

  const result = await withFetch(
    (async (input, init) => {
      callCount += 1
      assert.equal(input.toString(), 'https://server.example/identity/auth/login')
      assert.equal(init?.method, 'POST')
      assert.equal(init?.redirect, 'error')
      assert.deepEqual(init?.headers, { 'Content-Type': 'application/json' })
      assert.equal(init?.body, JSON.stringify({ email: 'admin@example.com', password: 'secret' }))
      return jsonResponse(loginSuccessBody)
    }) as typeof fetch,
    () => createIdentityClient(serverUrl).login('admin@example.com', 'secret')
  )

  assert.equal(result.outcome, 'succeeded')
  assert.deepEqual(result.value, {
    token: 'opaque-session-token',
    expiresAt: '2026-01-01T00:00:00Z',
    user: {
      id: 'user-1',
      email: 'admin@example.com',
      displayName: 'admin',
      role: 'admin',
      mustChangePassword: true
    }
  })
  assert.equal(callCount, 1)
})

test('authenticated calls carry the opaque token in the Authorization header only', async () => {
  await withFetch(
    (async (input, init) => {
      assert.equal(input.toString(), 'https://server.example/identity/users/me')
      assert.equal(init?.method, 'GET')
      assert.equal(new URL(input.toString()).search, '')
      assert.deepEqual(init?.headers, { Authorization: 'Bearer opaque-session-token' })
      return jsonResponse({ user: loginSuccessBody.user })
    }) as typeof fetch,
    async () => {
      const me = await createIdentityClient(serverUrl).me('opaque-session-token')
      assert.equal(me.outcome, 'succeeded')
      assert.deepEqual(me.value, {
        id: 'user-1',
        email: 'admin@example.com',
        displayName: 'admin',
        role: 'admin',
        mustChangePassword: true
      })
    }
  )

  await withFetch(
    (async (input, init) => {
      assert.equal(input.toString(), 'https://server.example/identity/auth/logout')
      assert.equal(init?.body, JSON.stringify({}))
      assert.deepEqual(init?.headers, {
        'Content-Type': 'application/json',
        Authorization: 'Bearer opaque-session-token'
      })
      return jsonResponse({ status: 'logged_out' })
    }) as typeof fetch,
    async () => {
      const logout = await createIdentityClient(serverUrl).logout('opaque-session-token')
      assert.equal(logout.outcome, 'succeeded')
    }
  )

  await withFetch(
    (async (input, init) => {
      assert.equal(input.toString(), 'https://server.example/identity/auth/change-password')
      assert.equal(
        init?.body,
        JSON.stringify({ current_password: 'initial', new_password: 'replacement' })
      )
      return jsonResponse({ status: 'password_changed' })
    }) as typeof fetch,
    async () => {
      const change = await createIdentityClient(serverUrl).changePassword(
        'opaque-session-token',
        'initial',
        'replacement'
      )
      assert.equal(change.outcome, 'succeeded')
    }
  )
})

test('a wrong password stays a credential verdict instead of a session rejection', async () => {
  await withFetch(
    (async () =>
      jsonResponse(
        { error: 'invalid_credentials', message: 'Email or password is wrong.' },
        401
      )) as typeof fetch,
    async () => {
      const result = await createIdentityClient(serverUrl).login('admin@example.com', 'wrong')
      assert.deepEqual(result, { outcome: 'request-rejected', code: 'invalid_credentials' })
    }
  )

  await withFetch(
    (async () =>
      jsonResponse(
        { error: 'invalid_credentials', message: 'The initial password is wrong.' },
        401
      )) as typeof fetch,
    async () => {
      const result = await createIdentityClient(serverUrl).changePassword(
        'opaque-session-token',
        'wrong',
        'replacement'
      )
      assert.deepEqual(result, { outcome: 'request-rejected', code: 'invalid_credentials' })
    }
  )
})

test('a rejected session, a disabled account, and a rate limit each keep their identity', async () => {
  await withFetch(
    (async () =>
      jsonResponse(
        { error: 'unauthorized', message: 'Authentication required.' },
        401
      )) as typeof fetch,
    async () => {
      const result = await createIdentityClient(serverUrl).me('revoked-token')
      assert.deepEqual(result, { outcome: 'unauthorized' })
    }
  )

  await withFetch(
    (async () =>
      jsonResponse(
        { error: 'account_disabled', message: 'This account is disabled.' },
        403
      )) as typeof fetch,
    async () => {
      const result = await createIdentityClient(serverUrl).login('member@example.com', 'secret')
      assert.deepEqual(result, { outcome: 'request-rejected', code: 'account_disabled' })
    }
  )

  await withFetch(
    (async () =>
      new Response(JSON.stringify({ error: 'login_rate_limited', message: 'Slow down.' }), {
        status: 429,
        headers: { 'Retry-After': '7' }
      })) as typeof fetch,
    async () => {
      const result = await createIdentityClient(serverUrl).login('member@example.com', 'secret')
      assert.deepEqual(result, { outcome: 'rate-limited' })
    }
  )

  await withFetch(
    (async () => jsonResponse({ error: 'password_change_required' }, 403)) as typeof fetch,
    async () => {
      const result = await createIdentityClient(serverUrl).me('gated-token')
      assert.deepEqual(result, { outcome: 'request-rejected', code: 'password_change_required' })
    }
  )
})

test('unreachable servers and unreadable bodies degrade to network failures, never verdicts', async () => {
  await withFetch(
    (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch,
    async () => {
      const result = await createIdentityClient(serverUrl).login('admin@example.com', 'secret')
      assert.deepEqual(result, { outcome: 'network-failure' })
    }
  )

  await withFetch((async () => new Response('{', { status: 200 })) as typeof fetch, async () => {
    const result = await createIdentityClient(serverUrl).login('admin@example.com', 'secret')
    assert.deepEqual(result, { outcome: 'network-failure' })
  })

  await withFetch(
    (async () => jsonResponse({ token: 'opaque-session-token' })) as typeof fetch,
    async () => {
      const result = await createIdentityClient(serverUrl).login('admin@example.com', 'secret')
      assert.deepEqual(result, { outcome: 'network-failure' })
    }
  )
})
