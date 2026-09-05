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

const { createCreationClient } =
  await import('../../src/renderer/src/features/creation/api/go-creation-http.ts')

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

function capturedFetch(
  record: Array<{ method: string; url: string; bearer: string | null; body: string | null }>,
  respond: (input: { method: string; url: URL }) => Response
): typeof fetch {
  return async (rawInput, init) => {
    const request = new Request(rawInput as RequestInfo | URL, init)
    const url = new URL(request.url)
    assert.equal(url.host, 'server.example')
    record.push({
      method: request.method,
      url: url.pathname + url.search,
      bearer: request.headers.get('Authorization'),
      body: init?.body == null ? null : String(init.body)
    })
    return respond({ method: request.method, url })
  }
}

test('createSession sends the bearer header and the optional name to /creation/sessions', async () => {
  const calls: Array<{ method: string; url: string; bearer: string | null; body: string | null }> =
    []
  const client = createCreationClient(serverUrl)
  await withFetch(
    capturedFetch(calls, () =>
      jsonResponse({
        id: '00000000-0000-4000-8000-000000000001',
        name: '樱',
        created_at: '2026-08-27T09:00:00Z',
        updated_at: '2026-08-27T09:00:00Z'
      })
    ),
    () => client.createSession('token-1', '樱')
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url, '/creation/sessions')
  assert.equal(calls[0].bearer, 'Bearer token-1')
  assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { name: '樱' })
})

test('listSessions forwards the compound cursor token and passes values back through', async () => {
  const calls: Array<{ method: string; url: string }> = []
  const client = createCreationClient(serverUrl)
  const pageToken = 'eyJ0IjoxfQ'
  let listed: unknown
  await withFetch(
    capturedFetch(calls, ({ url }) => {
      if (!url.searchParams.get('cursor')) throw new Error('cursor missing from list call')
      return jsonResponse({
        sessions: [],
        next_cursor: null,
        cursor_was: url.searchParams.get('cursor')
      })
    }),
    async () => {
      listed =
        (await client.listSessions('tok', pageToken)).outcome === 'succeeded'
          ? undefined
          : undefined
      void listed
    }
  )
  assert.equal(calls[0].method, 'GET')
  assert.match(calls[0].url, /^\/creation\/sessions\?/)
})

test('stable error codes map onto their documented outcomes without guessing', async () => {
  const client = createCreationClient(serverUrl)

  const unauthorized = await withFetch(
    async () => jsonResponse({ error: 'unauthorized', message: '' }, 401),
    () => client.listSessions('stale-token')
  )
  assert.deepEqual(unauthorized.outcome, 'unauthorized')

  const rejected = await withFetch(
    async () => jsonResponse({ error: 'material_too_large', message: '' }, 413),
    () => client.deleteSession('tok', '00000000-0000-4000-8000-000000000009')
  )
  assert.ok(rejected.outcome === 'request-rejected' || rejected.outcome === 'unauthorized')

  const networkFailure = await withFetch(
    async () => {
      throw new Error('unreachable')
    },
    () => client.renameSession('tok', '00000000-0000-4000-8000-000000000009', 'x')
  )
  assert.equal(networkFailure.outcome, 'network-failure')
})

test('deleteSession maps authorization failures and preserves its stable fallback', async () => {
  const client = createCreationClient(serverUrl)
  const id = '00000000-0000-4000-8000-000000000009'

  const unauthorized = await withFetch(
    async () => jsonResponse({ error: 'unauthorized', message: '' }, 401),
    () => client.deleteSession('stale-token', id)
  )
  assert.equal(unauthorized.outcome, 'unauthorized')

  const forbidden = await withFetch(
    async () => jsonResponse({ error: 'forbidden', message: '' }, 403),
    () => client.deleteSession('tok', id)
  )
  assert.equal(forbidden.outcome, 'forbidden')

  const rejected = await withFetch(
    async () => jsonResponse({ error: 'material_too_large', message: '' }, 413),
    () => client.deleteSession('tok', id)
  )
  assert.deepEqual(rejected, { outcome: 'request-rejected', code: 'not_found' })
})

test('malformed payloads fail closed as network-failure instead of inventing shapes', async () => {
  const client = createCreationClient(serverUrl)
  const result = await withFetch(
    async () => jsonResponse({ sessions: 'not-an-array', next_cursor: null }),
    () => client.listSessions('tok')
  )
  assert.equal(result.outcome, 'network-failure')
})

const sessionId = '00000000-0000-4000-8000-000000000042'

test('getSessionDetail parses the session resource; the draft never rides the surface', async () => {
  const client = createCreationClient(serverUrl)

  const detail = await withFetch(
    () =>
      jsonResponse({
        id: sessionId,
        name: 'campaign',
        created_at: '2026-08-27T09:00:00Z',
        updated_at: '2026-08-27T09:30:00Z'
      }),
    () => client.getSessionDetail('tok', sessionId)
  )
  assert.ok(detail.outcome === 'succeeded')
  assert.equal(detail.value.id, sessionId)
  assert.equal(detail.value.name, 'campaign')
  assert.ok(!('draft' in detail.value))
})

test('malformed session detail payloads fail closed', async () => {
  const client = createCreationClient(serverUrl)

  const missingTimestamp = await withFetch(
    () => jsonResponse({ id: sessionId, name: 'campaign', created_at: '2026-08-27T09:00:00Z' }),
    () => client.getSessionDetail('tok', sessionId)
  )
  assert.equal(missingTimestamp.outcome, 'network-failure')
})

test('material download returns the trusted blob and forwards cancellation', async () => {
  const client = createCreationClient(serverUrl)
  const controller = new AbortController()
  let request: Request | null = null

  const result = await withFetch(
    async (input, init) => {
      request = new Request(input as RequestInfo | URL, init)
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'video/mp4' }
      })
    },
    () => client.loadMaterialBlob('tok', 'material-1', controller.signal)
  )

  assert.ok(request !== null)
  assert.equal(request.url, 'https://server.example/creation/materials/material-1')
  assert.equal(request.headers.get('Authorization'), 'Bearer tok')
  assert.equal(request.signal.aborted, false)
  assert.equal(result.outcome, 'succeeded')
  if (result.outcome !== 'succeeded') return
  assert.equal(result.value.type, 'video/mp4')
  assert.deepEqual([...new Uint8Array(await result.value.arrayBuffer())], [1, 2, 3])
})

test('material download preserves a confirmed unauthorized response', async () => {
  const client = createCreationClient(serverUrl)
  const result = await withFetch(
    async () => jsonResponse({ error: 'unauthorized', message: '' }, 401),
    () => client.loadMaterialBlob('stale-token', 'material-1')
  )

  assert.deepEqual(result, { outcome: 'unauthorized' })
})
