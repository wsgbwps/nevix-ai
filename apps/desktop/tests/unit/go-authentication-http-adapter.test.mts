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

const { createGoAuthenticationOverHttp } =
  await import('../../src/renderer/src/features/authentication/api/go-authentication-http.ts')

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

function errorResponse(code: string, status: number): Response {
  return jsonResponse({ error: code, message: 'Adapter mapping test.' }, status)
}

const sessionBody = {
  token: 'opaque-session-token',
  expires_at: '2026-01-01T00:00:00Z',
  user: {
    id: 'user-1',
    email: 'admin@example.com',
    display_name: 'admin',
    role: 'admin',
    must_change_password: false
  }
}

const parsedSession = {
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

test('a successful operation surfaces its session as the Domain verdict', async () => {
  const go = createGoAuthenticationOverHttp(serverUrl)

  await withFetch((async () => jsonResponse(sessionBody)) as typeof fetch, async () => {
    assert.deepEqual(await go.signIn('admin@example.com', 'secret'), {
      outcome: 'succeeded',
      session: parsedSession
    })
  })
  await withFetch((async () => jsonResponse(sessionBody, 201)) as typeof fetch, async () => {
    assert.deepEqual(
      await go.claimInstance(
        'first.admin@example.com',
        'self-chosen-pass-1',
        'AB23CD45',
        'First Admin'
      ),
      { outcome: 'succeeded', session: parsedSession }
    )
  })
})

test('credential, disabled, and rate-limit verdicts keep their Authentication identities', async () => {
  const go = createGoAuthenticationOverHttp(serverUrl)

  await withFetch(
    (async () => errorResponse('invalid_credentials', 401)) as typeof fetch,
    async () => {
      assert.deepEqual(await go.signIn('admin@example.com', 'wrong'), {
        outcome: 'invalid-credentials'
      })
    }
  )
  await withFetch(
    (async () => errorResponse('account_disabled', 403)) as typeof fetch,
    async () => {
      assert.deepEqual(await go.signIn('member@example.com', 'secret'), {
        outcome: 'account-disabled'
      })
    }
  )
  await withFetch(
    (async () => errorResponse('invalid_join_code', 403)) as typeof fetch,
    async () => {
      assert.deepEqual(await go.register('member@example.com', 'secret', 'wrong', undefined), {
        outcome: 'invalid-join-code'
      })
    }
  )
  await withFetch((async () => errorResponse('email_taken', 409)) as typeof fetch, async () => {
    assert.deepEqual(await go.register('member@example.com', 'secret', 'JOIN-CODE', undefined), {
      outcome: 'email-taken'
    })
  })
  await withFetch(
    (async () => errorResponse('login_rate_limited', 429)) as typeof fetch,
    async () => {
      assert.deepEqual(await go.signIn('member@example.com', 'secret'), { outcome: 'rate-limited' })
      assert.deepEqual(await go.register('member@example.com', 'secret', 'JOIN-CODE', undefined), {
        outcome: 'rate-limited'
      })
    }
  )
})

test('the Instance Claim race and setup-code verdicts stay distinguishable', async () => {
  const go = createGoAuthenticationOverHttp(serverUrl)

  await withFetch(
    (async () => errorResponse('instance_already_initialized', 409)) as typeof fetch,
    async () => {
      assert.deepEqual(
        await go.claimInstance('first.admin@example.com', 'self-chosen-pass-1', 'AB23CD45', ''),
        { outcome: 'already-claimed' }
      )
    }
  )
  await withFetch(
    (async () => errorResponse('invalid_setup_code', 403)) as typeof fetch,
    async () => {
      assert.deepEqual(
        await go.claimInstance('first.admin@example.com', 'self-chosen-pass-1', '00000000', ''),
        { outcome: 'invalid-setup-code' }
      )
    }
  )
})

test('new-password length verdicts keep their identities on claim and registration', async () => {
  const go = createGoAuthenticationOverHttp(serverUrl)

  await withFetch(
    (async () => errorResponse('password_too_short', 400)) as typeof fetch,
    async () => {
      assert.deepEqual(await go.claimInstance('first.admin@example.com', 'short', 'AB23CD45', ''), {
        outcome: 'new-password-too-short'
      })
      assert.deepEqual(await go.register('member@example.com', 'short', 'JOIN-CODE', undefined), {
        outcome: 'new-password-too-short'
      })
    }
  )
  await withFetch(
    (async () => errorResponse('invalid_password', 400)) as typeof fetch,
    async () => {
      assert.deepEqual(
        await go.claimInstance('first.admin@example.com', 'x'.repeat(80), 'AB23CD45', ''),
        { outcome: 'new-password-over-limit' }
      )
      assert.deepEqual(
        await go.register('member@example.com', 'x'.repeat(80), 'JOIN-CODE', undefined),
        { outcome: 'new-password-over-limit' }
      )
    }
  )
})

test('session validation separates a rejected session from an unreachable server', async () => {
  const go = createGoAuthenticationOverHttp(serverUrl)

  await withFetch(
    (async () => jsonResponse({ user: sessionBody.user })) as typeof fetch,
    async () => {
      assert.deepEqual(await go.validateSession('opaque-session-token'), {
        outcome: 'succeeded',
        user: parsedSession.user
      })
    }
  )
  await withFetch((async () => errorResponse('unauthorized', 401)) as typeof fetch, async () => {
    assert.deepEqual(await go.validateSession('revoked-token'), { outcome: 'session-rejected' })
  })
  await withFetch(
    (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch,
    async () => {
      assert.deepEqual(await go.validateSession('opaque-session-token'), { outcome: 'unavailable' })
    }
  )
})

test('a forced password change keeps its wrong-current, rejected-new, and session verdicts', async () => {
  const go = createGoAuthenticationOverHttp(serverUrl)

  await withFetch(
    (async () => jsonResponse({ status: 'password_changed' })) as typeof fetch,
    async () => {
      assert.deepEqual(
        await go.changePassword('opaque-session-token', 'initial', 'replacement-pass-1'),
        { outcome: 'succeeded' }
      )
    }
  )
  await withFetch(
    (async () => errorResponse('invalid_credentials', 401)) as typeof fetch,
    async () => {
      assert.deepEqual(
        await go.changePassword('opaque-session-token', 'wrong', 'replacement-pass-1'),
        { outcome: 'invalid-current-password' }
      )
    }
  )
  await withFetch(
    (async () => errorResponse('invalid_password', 400)) as typeof fetch,
    async () => {
      assert.deepEqual(await go.changePassword('opaque-session-token', 'initial', 'short'), {
        outcome: 'new-password-rejected'
      })
    }
  )
  await withFetch((async () => errorResponse('unauthorized', 401)) as typeof fetch, async () => {
    assert.deepEqual(await go.changePassword('revoked-token', 'initial', 'replacement-pass-1'), {
      outcome: 'session-rejected'
    })
  })
  await withFetch(
    (async () => errorResponse('password_change_required', 403)) as typeof fetch,
    async () => {
      assert.deepEqual(
        await go.changePassword('opaque-session-token', 'initial', 'replacement-pass-1'),
        { outcome: 'unavailable' }
      )
    }
  )
})

test('sign-out reports only whether revocation was confirmed', async () => {
  const go = createGoAuthenticationOverHttp(serverUrl)

  await withFetch(
    (async () => jsonResponse({ status: 'logged_out' })) as typeof fetch,
    async () => {
      assert.deepEqual(await go.endSession('opaque-session-token'), { outcome: 'revoked' })
    }
  )
  await withFetch(
    (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch,
    async () => {
      assert.deepEqual(await go.endSession('opaque-session-token'), { outcome: 'unconfirmed' })
    }
  )
  await withFetch(
    (async () => errorResponse('login_rate_limited', 429)) as typeof fetch,
    async () => {
      assert.deepEqual(await go.endSession('opaque-session-token'), { outcome: 'unconfirmed' })
    }
  )
})

test('the setup probe answers both booleans or degrades to unavailable', async () => {
  const go = createGoAuthenticationOverHttp(serverUrl)

  await withFetch(
    (async () => jsonResponse({ initialized: false, setup_code_required: true })) as typeof fetch,
    async () => {
      assert.deepEqual(await go.probeSetup(), {
        outcome: 'succeeded',
        initialized: false,
        setupCodeRequired: true
      })
    }
  )
  await withFetch(
    (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch,
    async () => {
      assert.deepEqual(await go.probeSetup(), { outcome: 'unavailable' })
    }
  )
  await withFetch((async () => errorResponse('unauthorized', 401)) as typeof fetch, async () => {
    assert.deepEqual(await go.probeSetup(), { outcome: 'unavailable' })
  })
})

test('verdicts the Desktop does not map stay an unreachable-or-broken server', async () => {
  const go = createGoAuthenticationOverHttp(serverUrl)

  await withFetch((async () => errorResponse('email_taken', 409)) as typeof fetch, async () => {
    assert.deepEqual(await go.signIn('member@example.com', 'secret'), { outcome: 'unavailable' })
  })
  await withFetch((async () => errorResponse('unauthorized', 401)) as typeof fetch, async () => {
    assert.deepEqual(await go.signIn('member@example.com', 'secret'), { outcome: 'unavailable' })
  })
  await withFetch((async () => new Response('{', { status: 200 })) as typeof fetch, async () => {
    assert.deepEqual(await go.signIn('member@example.com', 'secret'), { outcome: 'unavailable' })
  })
})
