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

const client = await import('../../src/renderer/src/features/user-management/api/client.ts')

const serverUrl = 'https://server.example'
const session = { token: 'opaque-session-token' }

interface ObservedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string | undefined
}

async function withFetch<T>(
  implementation: (request: ObservedRequest) => Response,
  run: () => Promise<T>
): Promise<{ readonly requests: ObservedRequest[]; readonly result: T }> {
  const requests: ObservedRequest[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const request: ObservedRequest = {
      url: input.toString(),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body !== undefined ? String(init.body) : undefined
    }
    requests.push(request)
    return implementation(request)
  }) as typeof fetch
  try {
    return { requests, result: await run() }
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

const managedUserBody = {
  id: 'user-2',
  email: 'member@example.com',
  display_name: 'Member',
  role: 'member',
  status: 'active',
  must_change_password: true,
  last_login_at: null,
  created_at: '2026-08-23T10:00:00Z'
}

test('the management list sends pagination, search, and the bearer token on the admin endpoint', async () => {
  const { requests, result } = await withFetch(
    () => jsonResponse({ users: [managedUserBody], page: 2, per_page: 20, total: 21 }),
    () => client.listManagedUsers(session, serverUrl, { page: 2, perPage: 20, search: 'Member ' })
  )

  assert.deepEqual(requests, [
    {
      url: 'https://server.example/identity/admin/users?page=2&per_page=20&q=Member',
      method: 'GET',
      headers: { Authorization: 'Bearer opaque-session-token' },
      body: undefined
    }
  ])
  assert.deepEqual(result, {
    outcome: 'succeeded',
    value: {
      users: [
        {
          id: 'user-2',
          email: 'member@example.com',
          displayName: 'Member',
          role: 'member',
          status: 'active',
          mustChangePassword: true,
          lastLoginAt: null,
          createdAt: '2026-08-23T10:00:00Z'
        }
      ],
      page: 2,
      perPage: 20,
      total: 21
    }
  })
})

test('a blank search is omitted and every write rides the trusted-write discipline', async () => {
  const { requests, result } = await withFetch(
    () => jsonResponse({ users: [managedUserBody], page: 1, per_page: 20, total: 1 }),
    () => client.listManagedUsers(session, serverUrl, { page: 1, perPage: 20, search: '  ' })
  )
  assert.equal(requests[0].url, 'https://server.example/identity/admin/users?page=1&per_page=20')
  assert.equal(result.outcome, 'succeeded')

  const create = await withFetch(
    () => jsonResponse({ user: managedUserBody }, 201),
    () =>
      client.createUser(session, serverUrl, {
        email: 'Member@Example.com',
        initialPassword: 'secret-password',
        displayName: '  '
      })
  )
  assert.deepEqual(create.requests, [
    {
      url: 'https://server.example/identity/users',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer opaque-session-token'
      },
      body: JSON.stringify({
        email: 'Member@Example.com',
        initial_password: 'secret-password'
      })
    }
  ])
  assert.equal(create.result.outcome, 'succeeded')
})

test('governance commands address their user and map contract failures verbatim', async () => {
  const disable = await withFetch(
    () => jsonResponse({ user: managedUserBody }),
    () => client.disableUser(session, serverUrl, 'user-2')
  )
  assert.equal(disable.requests[0].method, 'POST')
  assert.equal(disable.requests[0].url, 'https://server.example/identity/users/user-2/disable')
  assert.equal(disable.requests[0].headers.Authorization, 'Bearer opaque-session-token')
  assert.equal(disable.result.outcome, 'succeeded')

  const reset = await withFetch(
    () => jsonResponse({ user: managedUserBody }),
    () => client.resetUserPassword(session, serverUrl, 'user-2', 'next-password')
  )
  assert.deepEqual(JSON.parse(reset.requests[0].body!), { initial_password: 'next-password' })

  const email = await withFetch(
    () => jsonResponse({ user: managedUserBody }),
    () => client.changeUserEmail(session, serverUrl, 'user-2', 'next@example.com')
  )
  assert.deepEqual(JSON.parse(email.requests[0].body!), { email: 'next@example.com' })

  const role = await withFetch(
    () => jsonResponse({ user: { ...managedUserBody, role: 'admin' } }),
    () => client.changeUserRole(session, serverUrl, 'user-2', 'admin')
  )
  assert.deepEqual(JSON.parse(role.requests[0].body!), { role: 'admin' })
  assert.deepEqual(role.result, {
    outcome: 'succeeded',
    value: {
      id: 'user-2',
      email: 'member@example.com',
      displayName: 'Member',
      role: 'admin',
      status: 'active',
      mustChangePassword: true,
      lastLoginAt: null,
      createdAt: '2026-08-23T10:00:00Z'
    }
  })

  const deletion = await withFetch(
    () => jsonResponse({ status: 'deleted' }),
    () => client.deleteUser(session, serverUrl, 'user-2')
  )
  assert.equal(deletion.requests[0].method, 'DELETE')
  assert.equal(deletion.requests[0].url, 'https://server.example/identity/users/user-2')
  assert.deepEqual(deletion.result, { outcome: 'succeeded', value: undefined })

  const rejected = await withFetch(
    () => jsonResponse({ error: 'last_admin_protected' }, 409),
    () => client.changeUserRole(session, serverUrl, 'user-1', 'member')
  )
  assert.deepEqual(rejected.result, { outcome: 'request-rejected', code: 'last_admin_protected' })

  const forbidden = await withFetch(
    () => jsonResponse({ error: 'forbidden' }, 403),
    () => client.listManagedUsers(session, serverUrl, { page: 1, perPage: 20 })
  )
  assert.deepEqual(forbidden.result, { outcome: 'forbidden' })

  const unauthorized = await withFetch(
    () => jsonResponse({ error: 'unauthorized' }, 401),
    () => client.listAuditLogs(session, serverUrl, { page: 1, perPage: 20 })
  )
  assert.deepEqual(unauthorized.result, { outcome: 'unauthorized' })

  const offline = await withFetch(
    () => {
      throw new Error('network down')
    },
    () => client.listAuditLogs(session, serverUrl, { page: 1, perPage: 20 })
  )
  assert.deepEqual(offline.result, { outcome: 'network-failure' })
})

test('an audit page is parsed strictly and a malformed answer never fakes success', async () => {
  const entryBody = {
    id: 'entry-1',
    action: 'user_created',
    actor_user_id: 'user-1',
    actor_display_name: 'Admin',
    target_user_id: 'user-2',
    target_display_name: 'Member',
    metadata: { email: 'member@example.com' },
    created_at: '2026-08-23T10:05:00Z'
  }

  const good = await withFetch(
    () => jsonResponse({ entries: [entryBody], page: 1, per_page: 20, total: 1 }),
    () => client.listAuditLogs(session, serverUrl, { page: 1, perPage: 20 })
  )
  assert.deepEqual(good.result, {
    outcome: 'succeeded',
    value: {
      entries: [
        {
          id: 'entry-1',
          action: 'user_created',
          actorUserId: 'user-1',
          actorDisplayName: 'Admin',
          targetUserId: 'user-2',
          targetDisplayName: 'Member',
          metadata: { email: 'member@example.com' },
          createdAt: '2026-08-23T10:05:00Z'
        }
      ],
      page: 1,
      perPage: 20,
      total: 1
    }
  })

  const malformedUser = await withFetch(
    () =>
      jsonResponse({
        users: [{ ...managedUserBody, role: 'owner' }],
        page: 1,
        per_page: 20,
        total: 1
      }),
    () => client.listManagedUsers(session, serverUrl, { page: 1, perPage: 20 })
  )
  assert.deepEqual(malformedUser.result, { outcome: 'network-failure' })

  const malformedDelete = await withFetch(
    () => jsonResponse({ status: 'kept' }),
    () => client.deleteUser(session, serverUrl, 'user-2')
  )
  assert.deepEqual(malformedDelete.result, { outcome: 'network-failure' })
})
