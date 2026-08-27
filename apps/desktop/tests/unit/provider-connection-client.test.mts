import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
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

const { createProviderConnectionClient } =
  await import('../../src/renderer/src/features/creation/api/provider-connection-http.ts')

/**
 * Unit coverage for the AI Provider Connection settings client (issue #157):
 * the trusted-command mechanics only — exact paths, methods, Bearer header,
 * and the stable reason mapping. Response-shape parsing fails closed.
 */

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

const connectionView = {
  id: '4b7a2b1e-0d5f-4a3c-9d2e-107cb28a1111',
  admin_state: 'enabled',
  credential_state: 'valid',
  image_capability: 'available',
  video_capability: 'unavailable',
  created_at: '2026-08-27T02:00:00Z',
  updated_at: '2026-08-27T02:00:00Z',
  last_checked_at: '2026-08-27T02:00:00Z',
  last_check_outcome: 'completed',
  needs_attention: true
}

describe('provider connection client', () => {
  it('sends the exact contract paths and methods with the Bearer token', async () => {
    const requests: Request[] = []
    await withFetch(
      (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        return Promise.resolve(jsonResponse(connectionView, 200))
      },
      async () => {
        const client = createProviderConnectionClient(serverUrl)
        await client.lookup('token-a')
        await client.configure('token-a', 'proof', 'key')
        await client.replaceCredential('token-a', 'proof', 'key')
        await client.setAdminState('token-a', 'paused')
        await client.recheck('token-a')
        await client.deleteConnection('token-a', 'proof')
        await client.listMediaCapabilities('token-a')
      }
    )
    assert.deepEqual(
      requests.map((request) => [request.method, new URL(request.url).pathname]),
      [
        ['GET', '/creation/provider-connection'],
        ['POST', '/creation/provider-connection'],
        ['PUT', '/creation/provider-connection/credential'],
        ['PATCH', '/creation/provider-connection'],
        ['POST', '/creation/provider-connection/recheck'],
        ['DELETE', '/creation/provider-connection'],
        ['GET', '/creation/media-capabilities']
      ] as const
    )
    for (const request of requests) {
      assert.equal(request.headers.get('Authorization'), 'Bearer token-a')
    }
  })

  it('never places the token, proof, or provider key in a URL', async () => {
    let observedUrl = ''
    await withFetch(
      (input, init) => {
        const request = new Request(input, init)
        observedUrl = request.url
        return Promise.resolve(jsonResponse(connectionView, 201))
      },
      async () => {
        const client = createProviderConnectionClient(serverUrl)
        const result = await client.configure('secret-token', 'secret-proof', 'secret-key')
        assert.equal(result.outcome, 'succeeded')
      }
    )
    const url = new URL(observedUrl)
    assert.equal(url.search, '')
    assert.ok(!observedUrl.includes('secret-token'))
    assert.ok(!observedUrl.includes('secret-key'))
  })

  it('maps not-configured and stable error codes without guessing verdicts', async () => {
    await withFetch(
      (input, init) => {
        const request = new Request(input, init)
        const { pathname } = new URL(request.url)
        if (pathname === '/creation/provider-connection' && request.method === 'GET') {
          return Promise.resolve(
            jsonResponse({ error: 'provider_connection_not_configured', message: 'none' }, 404)
          )
        }
        if (pathname === '/creation/media-capabilities') {
          return Promise.resolve(
            jsonResponse({
              image: { status: 'unavailable', reason: 'not_configured', action: 'contact_admin' },
              video: { status: 'unavailable', reason: 'not_configured', action: 'contact_admin' }
            })
          )
        }
        return Promise.resolve(
          jsonResponse({ error: 'secure_transport_required', message: 'https' }, 400)
        )
      },
      async () => {
        const client = createProviderConnectionClient(serverUrl)
        const lookup = await client.lookup('token')
        assert.equal(lookup.outcome, 'not-configured')

        const configure = await client.configure('token', 'proof', 'key')
        assert.deepEqual(configure, {
          outcome: 'request-rejected',
          code: 'secure_transport_required'
        })

        const capabilities = await client.listMediaCapabilities('token')
        assert.equal(capabilities.outcome, 'succeeded')
        if (capabilities.outcome === 'succeeded') {
          assert.equal(capabilities.value.image.reason, 'not_configured')
          assert.equal(capabilities.value.image.action, 'contact_admin')
        }
      }
    )
  })

  it('parses the sanitized admin view and fails closed on broken shapes', async () => {
    await withFetch(
      () => Promise.resolve(jsonResponse(connectionView)),
      async () => {
        const client = createProviderConnectionClient(serverUrl)
        const lookup = await client.lookup('token')
        assert.equal(lookup.outcome, 'configured')
        if (lookup.outcome === 'configured') {
          assert.equal(lookup.connection.credentialState, 'valid')
          assert.equal(lookup.connection.videoCapability, 'unavailable')
          assert.equal(lookup.connection.needsAttention, true)
          assert.equal(lookup.connection.lastCheckOutcome, 'completed')
        }
      }
    )
    await withFetch(
      () => Promise.resolve(jsonResponse({ id: 'x' })),
      async () => {
        const client = createProviderConnectionClient(serverUrl)
        const lookup = await client.lookup('token')
        assert.equal(lookup.outcome, 'load-failed')
      }
    )
  })
})
