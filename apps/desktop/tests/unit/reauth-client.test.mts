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

const { createReauthProofRequester, isReauthAction, REAUTH_ACTIONS } =
  await import('../../src/renderer/src/features/authentication/api/reauth.ts')

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

const issueSuccessBody = {
  proof: 'opaque-proof-token',
  action: 'provider_connection.replace',
  expires_at: '2026-09-01T00:05:00Z'
}

test('the closed exact-action set admits only the three declared actions', () => {
  assert.deepEqual(REAUTH_ACTIONS, [
    'provider_connection.create',
    'provider_connection.replace',
    'provider_connection.delete'
  ])
  for (const action of REAUTH_ACTIONS) {
    assert.equal(isReauthAction(action), true)
  }
  for (const guess of ['user.delete', '', 'provider_connection', 'provider_connection.CREATE']) {
    assert.equal(isReauthAction(guess), false)
  }
})

test('issue sends action and password with the bearer token and parses the proof', async () => {
  let callCount = 0

  const result = await withFetch(
    (async (input, init) => {
      callCount += 1
      assert.equal(input.toString(), 'https://server.example/identity/admin/reauth/proofs')
      assert.equal(init?.method, 'POST')
      assert.equal(init?.redirect, 'error')
      assert.deepEqual(init?.headers, {
        'Content-Type': 'application/json',
        Authorization: 'Bearer opaque-session-token'
      })
      assert.equal(
        init?.body,
        JSON.stringify({ action: 'provider_connection.replace', password: 'secret' })
      )
      return jsonResponse(issueSuccessBody)
    }) as typeof fetch,
    () =>
      createReauthProofRequester(serverUrl).issue(
        'opaque-session-token',
        'provider_connection.replace',
        'secret'
      )
  )

  assert.equal(callCount, 1)
  assert.deepEqual(result, {
    outcome: 'succeeded',
    value: {
      proof: 'opaque-proof-token',
      action: 'provider_connection.replace',
      expiresAt: '2026-09-01T00:05:00Z'
    }
  })
})

test('an undeclared action never reaches the network', async () => {
  let callCount = 0
  const result = await withFetch(
    (async () => {
      callCount += 1
      return jsonResponse({})
    }) as typeof fetch,
    () =>
      createReauthProofRequester(serverUrl).issue(
        'opaque-session-token',
        // The runtime guard stands in for the compile-time union a caller
        // would have to subvert to get here.
        'user.delete' as 'provider_connection.replace',
        'secret'
      )
  )
  assert.equal(callCount, 0)
  assert.deepEqual(result, { outcome: 'request-rejected', code: 'invalid_action' })
})

test('a wrong password maps to the invalid_credentials code, not forced sign-out', async () => {
  const result = await withFetch(
    (async () =>
      jsonResponse(
        { error: 'invalid_credentials', message: 'Email or password is incorrect.' },
        401
      )) as typeof fetch,
    () =>
      createReauthProofRequester(serverUrl).issue(
        'opaque-session-token',
        'provider_connection.create',
        'wrong'
      )
  )
  assert.deepEqual(result, { outcome: 'request-rejected', code: 'invalid_credentials' })
})

test('a rejected session maps to forced sign-out; other 401-family codes stay request-rejected', async () => {
  const unauthorized = await withFetch(
    (async () =>
      jsonResponse(
        { error: 'unauthorized', message: 'Authentication required.' },
        401
      )) as typeof fetch,
    () =>
      createReauthProofRequester(serverUrl).issue(
        'stale-session-token',
        'provider_connection.create',
        'secret'
      )
  )
  assert.deepEqual(unauthorized, { outcome: 'unauthorized' })

  const forbidden = await withFetch(
    (async () =>
      jsonResponse(
        { error: 'forbidden', message: 'Administrator role is required.' },
        403
      )) as typeof fetch,
    () =>
      createReauthProofRequester(serverUrl).issue(
        'member-session-token',
        'provider_connection.create',
        'secret'
      )
  )
  assert.deepEqual(forbidden, { outcome: 'request-rejected', code: 'forbidden' })
})

test('the stable secure-transport and rate-limit codes survive mapping; unknowns stay generic', async () => {
  const secureTransport = await withFetch(
    (async () =>
      jsonResponse(
        { error: 'secure_transport_required', message: 'A proven HTTPS transport is required.' },
        400
      )) as typeof fetch,
    () =>
      createReauthProofRequester(serverUrl).issue(
        'opaque-session-token',
        'provider_connection.delete',
        'secret'
      )
  )
  assert.deepEqual(secureTransport, {
    outcome: 'request-rejected',
    code: 'secure_transport_required'
  })

  const rateLimited = await withFetch(
    (async () =>
      new Response(JSON.stringify({ error: 'login_rate_limited', message: 'Slow down.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '120' }
      })) as typeof fetch,
    () =>
      createReauthProofRequester(serverUrl).issue(
        'opaque-session-token',
        'provider_connection.delete',
        'secret'
      )
  )
  assert.deepEqual(rateLimited, { outcome: 'rate-limited' })

  const unknown = await withFetch(
    (async () =>
      jsonResponse({ error: 'brand_new_code', message: 'Unimagined.' }, 409)) as typeof fetch,
    () =>
      createReauthProofRequester(serverUrl).issue(
        'opaque-session-token',
        'provider_connection.delete',
        'secret'
      )
  )
  assert.deepEqual(unknown, { outcome: 'request-rejected', code: 'brand_new_code' })
})

test('a 200 body whose echoed action disagrees with the request is not a proof', async () => {
  const mismatched = await withFetch(
    (async () =>
      jsonResponse({ ...issueSuccessBody, action: 'provider_connection.delete' })) as typeof fetch,
    () =>
      createReauthProofRequester(serverUrl).issue(
        'opaque-session-token',
        'provider_connection.replace',
        'secret'
      )
  )
  assert.deepEqual(mismatched, { outcome: 'network-failure' })

  const missing = await withFetch(
    (async () =>
      jsonResponse({
        proof: issueSuccessBody.proof,
        expires_at: issueSuccessBody.expires_at
      })) as typeof fetch,
    () =>
      createReauthProofRequester(serverUrl).issue(
        'opaque-session-token',
        'provider_connection.replace',
        'secret'
      )
  )
  assert.deepEqual(missing, { outcome: 'network-failure' })
})

test('an unreadable body is a network failure, never a credential verdict', async () => {
  const malformed = await withFetch(
    (async () => new Response('<html>not json</html>', { status: 200 })) as typeof fetch,
    () =>
      createReauthProofRequester(serverUrl).issue(
        'opaque-session-token',
        'provider_connection.create',
        'secret'
      )
  )
  assert.deepEqual(malformed, { outcome: 'network-failure' })

  const malformedSuccess = await withFetch(
    (async () => jsonResponse({ proof: '', expires_at: 'nope' })) as typeof fetch,
    () =>
      createReauthProofRequester(serverUrl).issue(
        'opaque-session-token',
        'provider_connection.create',
        'secret'
      )
  )
  assert.deepEqual(malformedSuccess, { outcome: 'network-failure' })
})
