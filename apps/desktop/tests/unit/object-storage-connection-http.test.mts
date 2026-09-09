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

const { createObjectStorageConnectionClient } =
  await import('../../src/renderer/src/features/creation/api/object-storage-connection-http.ts')

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

const readyView = {
  state: 'ready',
  provider: 'oss',
  region: 'cn-hangzhou',
  bucket: 'nevix-reference-materials',
  revision: 7,
  credential: {
    access_key_id_masked: '****7890',
    secret_access_key_configured: true
  },
  observation: {
    checked_at: '2026-09-09T05:00:00Z',
    outcome: 'completed'
  }
}

test('Admin lookup reads the sanitized connection state with a bearer session', async () => {
  const calls: Array<{ method: string; path: string; bearer: string | null }> = []
  const result = await withFetch(
    (async (input, init) => {
      const request = new Request(input, init)
      calls.push({
        method: request.method,
        path: new URL(request.url).pathname,
        bearer: request.headers.get('Authorization')
      })
      return jsonResponse(readyView)
    }) as typeof fetch,
    () => createObjectStorageConnectionClient(serverUrl).getAdminConnection('admin-token')
  )

  assert.deepEqual(calls, [
    {
      method: 'GET',
      path: '/creation/object-storage-connection',
      bearer: 'Bearer admin-token'
    }
  ])
  assert.deepEqual(result, {
    outcome: 'succeeded',
    value: {
      state: 'ready',
      provider: 'oss',
      region: 'cn-hangzhou',
      bucket: 'nevix-reference-materials',
      revision: 7,
      credential: {
        accessKeyIdMasked: '****7890',
        secretAccessKeyConfigured: true
      },
      observation: { checkedAt: '2026-09-09T05:00:00Z', outcome: 'completed' }
    }
  })
})

test('Admin lookup preserves the explicit unconfigured state without inventing location facts', async () => {
  const result = await withFetch(
    (async () => jsonResponse({ state: 'unconfigured' })) as typeof fetch,
    () => createObjectStorageConnectionClient(serverUrl).getAdminConnection('admin-token')
  )

  assert.deepEqual(result, { outcome: 'succeeded', value: { state: 'unconfigured' } })
})

test('create sends the exact candidate and proof, then returns only the masked view', async () => {
  let request: Request | undefined
  let body: unknown
  const result = await withFetch(
    (async (input, init) => {
      request = new Request(input, init)
      body = JSON.parse(String(init?.body))
      return jsonResponse(readyView, 201)
    }) as typeof fetch,
    () =>
      createObjectStorageConnectionClient(serverUrl).create('admin-token', {
        proof: 'exact-action-proof',
        provider: 'oss',
        region: 'cn-hangzhou',
        bucket: 'nevix-reference-materials',
        accessKeyId: 'LTAI1234567890',
        secretAccessKey: 'candidate-secret'
      })
  )

  assert.equal(request?.method, 'POST')
  assert.equal(new URL(request?.url ?? '').pathname, '/creation/object-storage-connection')
  assert.deepEqual(body, {
    proof: 'exact-action-proof',
    provider: 'oss',
    region: 'cn-hangzhou',
    bucket: 'nevix-reference-materials',
    access_key_id: 'LTAI1234567890',
    secret_access_key: 'candidate-secret'
  })
  assert.equal(result.outcome, 'succeeded')
  if (result.outcome !== 'succeeded') return
  assert.equal(result.value.credential.accessKeyIdMasked, '****7890')
  assert.equal('accessKeyId' in result.value.credential, false)
  assert.equal('secretAccessKey' in result.value.credential, false)
})

test('malformed credential payloads fail closed instead of accepting echoed secrets', async () => {
  const result = await withFetch(
    (async () =>
      jsonResponse({
        ...readyView,
        credential: {
          access_key_id: 'raw-access-key',
          secret_access_key: 'raw-secret'
        }
      })) as typeof fetch,
    () => createObjectStorageConnectionClient(serverUrl).getAdminConnection('admin-token')
  )

  assert.deepEqual(result, { outcome: 'network-failure' })
})

test('active-user capability keeps unavailable views origin-free and parses ready origin', async () => {
  const client = createObjectStorageConnectionClient(serverUrl)
  const unavailable = await withFetch(
    (async () =>
      jsonResponse({ available: false, provider: 'cos', connection_revision: 9 })) as typeof fetch,
    () => client.getCapability('member-token')
  )
  assert.deepEqual(unavailable, {
    outcome: 'succeeded',
    value: { available: false, provider: 'cos', connectionRevision: 9 }
  })
  assert.equal(
    'uploadOrigin' in (unavailable.outcome === 'succeeded' ? unavailable.value : {}),
    false
  )

  const ready = await withFetch(
    (async () =>
      jsonResponse({
        available: true,
        provider: 'oss',
        upload_origin: 'https://nevix-reference-materials.oss-cn-hangzhou.aliyuncs.com',
        connection_revision: 10
      })) as typeof fetch,
    () => client.getCapability('member-token')
  )
  assert.deepEqual(ready, {
    outcome: 'succeeded',
    value: {
      available: true,
      provider: 'oss',
      uploadOrigin: 'https://nevix-reference-materials.oss-cn-hangzhou.aliyuncs.com',
      connectionRevision: 10
    }
  })
})
