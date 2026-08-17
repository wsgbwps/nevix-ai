import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import test, { after } from 'node:test'

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

const { OrganizationCommandError, requestOrganizationCommand } =
  await import('../../src/renderer/src/features/organization/api/command-client.ts')
const { createOrganization } =
  await import('../../src/renderer/src/features/organization/api/create-organization.ts')
const { acceptInvitation, InvitationAcceptanceError } =
  await import('../../src/renderer/src/features/organization/api/invitations.ts')

type TestGlobals = typeof globalThis & {
  __NEVIX_SERVER_URL__?: string
  __NEVIX_SERVER_CONFIG_POLICY__?: 'https-only' | 'private-network-http'
}

const testGlobals = globalThis as TestGlobals
const originalServerUrl = testGlobals.__NEVIX_SERVER_URL__
const originalServerConfigPolicy = testGlobals.__NEVIX_SERVER_CONFIG_POLICY__

testGlobals.__NEVIX_SERVER_URL__ = 'https://server.example'
testGlobals.__NEVIX_SERVER_CONFIG_POLICY__ = 'https-only'

after(() => {
  if (originalServerUrl === undefined) delete testGlobals.__NEVIX_SERVER_URL__
  else testGlobals.__NEVIX_SERVER_URL__ = originalServerUrl

  if (originalServerConfigPolicy === undefined) delete testGlobals.__NEVIX_SERVER_CONFIG_POLICY__
  else testGlobals.__NEVIX_SERVER_CONFIG_POLICY__ = originalServerConfigPolicy
})

async function withFetch<T>(implementation: typeof fetch, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = implementation
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('trusted command adapter owns authorization, JSON transport, cancellation, and success parsing', async () => {
  const controller = new AbortController()
  let callCount = 0

  const result = await withFetch(
    (async (input, init) => {
      callCount += 1
      assert.equal(
        input.toString(),
        'https://server.example/identity/organizations/organization-1/name'
      )
      assert.equal(init?.method, 'PATCH')
      assert.equal(init?.redirect, 'error')
      assert.deepEqual(init?.headers, {
        Accept: 'application/json',
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json'
      })
      assert.equal(init?.body, JSON.stringify({ name: 'Renamed' }))
      assert.equal(init?.signal, controller.signal)
      return new Response(JSON.stringify({ id: 'organization-1', name: 'Renamed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }) as typeof fetch,
    () =>
      requestOrganizationCommand({
        path: '/identity/organizations/organization-1/name',
        accessToken: 'access-token',
        method: 'PATCH',
        body: { name: 'Renamed' },
        signal: controller.signal
      })
  )

  assert.deepEqual(result, { id: 'organization-1', name: 'Renamed' })
  assert.equal(callCount, 1)
})

test('trusted command adapter normalizes failures and retains only declared headers without retrying', async () => {
  let callCount = 0

  await withFetch(
    (async () => {
      callCount += 1
      return new Response(
        JSON.stringify({ error: 'invitation_rate_limited', message: 'Please wait.' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '7',
            'X-Invitation-Code-Attempts-Remaining': '2',
            'X-Internal-Diagnostic': 'must-not-escape'
          }
        }
      )
    }) as typeof fetch,
    async () => {
      await assert.rejects(
        requestOrganizationCommand({
          path: '/identity/invitations/invitation-1/accept',
          accessToken: 'access-token',
          method: 'POST',
          body: { code: '12345678' },
          captureErrorHeaders: ['X-Invitation-Code-Attempts-Remaining']
        }),
        (error) => {
          assert.ok(error instanceof OrganizationCommandError)
          assert.equal(error.code, 'invitation_rate_limited')
          assert.equal(error.status, 429)
          assert.equal(error.retryAfterSeconds, 7)
          assert.equal(error.serverMessage, 'Please wait.')
          assert.deepEqual(error.capturedHeaders, {
            'x-invitation-code-attempts-remaining': '2'
          })
          assert.equal('x-internal-diagnostic' in error.capturedHeaders, false)
          return true
        }
      )
    }
  )

  assert.equal(callCount, 1)
})

test('trusted command adapter rejects redirects without replaying a trusted write', async () => {
  let initialRequestCount = 0
  let redirectedRequestCount = 0
  const server = createServer((request, response) => {
    if (request.url === '/identity/redirect') {
      initialRequestCount += 1
      response.writeHead(307, { Location: '/identity/replayed' })
      response.end()
      return
    }

    redirectedRequestCount += 1
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{}')
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  const previousServerUrl = testGlobals.__NEVIX_SERVER_URL__
  const previousPolicy = testGlobals.__NEVIX_SERVER_CONFIG_POLICY__
  testGlobals.__NEVIX_SERVER_URL__ = `http://127.0.0.1:${address.port}`
  testGlobals.__NEVIX_SERVER_CONFIG_POLICY__ = 'private-network-http'

  try {
    await assert.rejects(
      requestOrganizationCommand({
        path: '/identity/redirect',
        accessToken: 'access-token',
        method: 'POST',
        body: { command: 'write' }
      }),
      (error) => {
        assert.ok(error instanceof TypeError)
        return true
      }
    )
  } finally {
    testGlobals.__NEVIX_SERVER_URL__ = previousServerUrl
    testGlobals.__NEVIX_SERVER_CONFIG_POLICY__ = previousPolicy
    server.close()
    await once(server, 'close')
  }

  assert.equal(initialRequestCount, 1)
  assert.equal(redirectedRequestCount, 0)
})

test('trusted command adapter rejects malformed successful JSON', async () => {
  await withFetch((async () => new Response('{', { status: 200 })) as typeof fetch, async () => {
    await assert.rejects(
      requestOrganizationCommand({
        path: '/identity/organizations',
        accessToken: 'access-token',
        method: 'POST',
        body: {}
      }),
      /Organization command response is invalid\./
    )
  })
})

test('Create Organization preserves request and response validation behavior', async () => {
  await withFetch(
    (async (input, init) => {
      assert.equal(input.toString(), 'https://server.example/identity/organizations')
      assert.equal(init?.method, 'POST')
      assert.equal(init?.redirect, 'error')
      assert.equal(init?.body, JSON.stringify({ id: 'organization-1', name: 'Alpha' }))
      return new Response(
        JSON.stringify({ organization: { id: 'organization-1', name: 'Alpha' } }),
        { status: 200 }
      )
    }) as typeof fetch,
    async () => {
      assert.deepEqual(
        await createOrganization({
          accessToken: 'access-token',
          id: 'organization-1',
          name: 'Alpha'
        }),
        { id: 'organization-1', name: 'Alpha' }
      )
    }
  )

  await withFetch(
    (async () =>
      new Response(JSON.stringify({ id: 'organization-1' }), { status: 200 })) as typeof fetch,
    async () => {
      await assert.rejects(
        createOrganization({
          accessToken: 'access-token',
          id: 'organization-1',
          name: 'Alpha'
        }),
        /Organization response is invalid\./
      )
    }
  )

  await withFetch(
    (async () =>
      new Response(
        JSON.stringify({ organization: { id: 'different-organization', name: 'Alpha' } }),
        { status: 200 }
      )) as typeof fetch,
    async () => {
      await assert.rejects(
        createOrganization({
          accessToken: 'access-token',
          id: 'organization-1',
          name: 'Alpha'
        }),
        /Organization response is invalid\./
      )
    }
  )

  await withFetch(
    (async () =>
      new Response(JSON.stringify({ organization: { id: 'organization-1', name: 42 } }), {
        status: 200
      })) as typeof fetch,
    async () => {
      await assert.rejects(
        createOrganization({
          accessToken: 'access-token',
          id: 'organization-1',
          name: 'Alpha'
        }),
        /Organization response is invalid\./
      )
    }
  )
})

test('Create Organization preserves its generic request failure', async () => {
  await withFetch(
    (async () =>
      new Response(JSON.stringify({ error: 'organization_conflict', message: 'Already exists.' }), {
        status: 409
      })) as typeof fetch,
    async () => {
      await assert.rejects(
        createOrganization({
          accessToken: 'access-token',
          id: 'organization-1',
          name: 'Alpha'
        }),
        /Organization request failed\./
      )
    }
  )
})

test('Invitation acceptance preserves domain failure metadata and response validation', async () => {
  await withFetch(
    (async (_input, init) => {
      assert.equal(init?.redirect, 'error')
      return new Response(
        JSON.stringify({ error: 'invitation_rate_limited', message: 'Too many attempts.' }),
        {
          status: 429,
          headers: { 'X-Invitation-Code-Attempts-Remaining': '1' }
        }
      )
    }) as typeof fetch,
    async () => {
      await assert.rejects(
        acceptInvitation({
          session: { accessToken: 'access-token', userId: 'user-1', email: 'person@example.com' },
          invitationId: 'invitation-1',
          code: '12345678'
        }),
        (error) => {
          assert.ok(error instanceof InvitationAcceptanceError)
          assert.equal(error.code, 'invitation_rate_limited')
          assert.equal(error.attemptsRemaining, 1)
          assert.equal(error.message, 'Too many attempts.')
          return true
        }
      )
    }
  )

  await withFetch(
    (async () =>
      new Response(
        JSON.stringify({
          membership: { organization_id: 'organization-1' }
        }),
        { status: 200 }
      )) as typeof fetch,
    async () => {
      assert.deepEqual(
        await acceptInvitation({
          session: { accessToken: 'access-token', userId: 'user-1', email: 'person@example.com' },
          invitationId: 'invitation-1',
          code: '12345678'
        }),
        { organizationId: 'organization-1' }
      )
    }
  )

  await withFetch(
    (async () =>
      new Response(JSON.stringify({ membership: { organization_id: '' } }), {
        status: 200
      })) as typeof fetch,
    async () => {
      await assert.rejects(
        acceptInvitation({
          session: { accessToken: 'access-token', userId: 'user-1', email: 'person@example.com' },
          invitationId: 'invitation-1',
          code: '12345678'
        }),
        /Invitation acceptance response is invalid\./
      )
    }
  )
})
