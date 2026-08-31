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

test('malformed payloads fail closed as network-failure instead of inventing shapes', async () => {
  const client = createCreationClient(serverUrl)
  const result = await withFetch(
    async () => jsonResponse({ sessions: 'not-an-array', next_cursor: null }),
    () => client.listSessions('tok')
  )
  assert.equal(result.outcome, 'network-failure')
})

const sessionId = '00000000-0000-4000-8000-000000000042'

test('saveSessionDraft PUTs the snake_case draft with the bearer header', async () => {
  const calls: Array<{ method: string; url: string; bearer: string | null; body: string | null }> =
    []
  const client = createCreationClient(serverUrl)
  const stored = await withFetch(
    capturedFetch(calls, () =>
      jsonResponse({
        prompt: '暖光跑鞋',
        media_type: 'image',
        manifest_version: 1,
        updated_at: '2026-08-29T10:00:00Z',
        model: 'doubao-seedream-5.0-lite',
        mode: 'reference-image',
        ratio: '4:5',
        resolution: '2K',
        quantity: 2,
        duration_seconds: null,
        references: [
          { material_id: 'cccccccc-0000-4000-8000-000000000003', role: 'reference' },
          { material_id: 'dddddddd-0000-4000-8000-000000000004', role: 'reference' }
        ]
      })
    ),
    () =>
      client.saveSessionDraft('token-1', sessionId, {
        prompt: '暖光跑鞋',
        mediaType: 'image',
        manifestVersion: 1,
        model: 'doubao-seedream-5.0-lite',
        mode: 'reference-image',
        ratio: '4:5',
        resolution: '2K',
        quantity: 2,
        durationSeconds: null,
        references: [
          { materialId: 'cccccccc-0000-4000-8000-000000000003', role: 'reference' },
          { materialId: 'dddddddd-0000-4000-8000-000000000004', role: 'reference' }
        ]
      })
  )

  assert.equal(calls[0].method, 'PUT')
  assert.equal(calls[0].url, `/creation/sessions/${sessionId}/draft`)
  assert.equal(calls[0].bearer, 'Bearer token-1')
  assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), {
    prompt: '暖光跑鞋',
    media_type: 'image',
    manifest_version: 1,
    model: 'doubao-seedream-5.0-lite',
    mode: 'reference-image',
    ratio: '4:5',
    resolution: '2K',
    quantity: 2,
    duration_seconds: null,
    references: [
      { material_id: 'cccccccc-0000-4000-8000-000000000003', role: 'reference' },
      { material_id: 'dddddddd-0000-4000-8000-000000000004', role: 'reference' }
    ]
  })
  assert.equal(stored.outcome, 'succeeded')
})

test('getSessionDetail recovers the stored draft and passes null through', async () => {
  const client = createCreationClient(serverUrl)

  const withDraft = await withFetch(
    () =>
      jsonResponse({
        id: sessionId,
        name: 'campaign',
        created_at: '2026-08-27T09:00:00Z',
        updated_at: '2026-08-27T09:30:00Z',
        draft: {
          prompt: 'p',
          media_type: null,
          manifest_version: 3,
          updated_at: '2026-08-29T10:00:00Z',
          model: null,
          mode: null,
          ratio: null,
          resolution: '2K',
          quantity: null,
          duration_seconds: null,
          references: []
        }
      }),
    () => client.getSessionDetail('tok', sessionId)
  )
  assert.ok(withDraft.outcome === 'succeeded')
  assert.equal(withDraft.value.draft?.manifestVersion, 3)
  assert.equal(withDraft.value.draft?.mediaType, null)

  const withoutDraft = await withFetch(
    () =>
      jsonResponse({
        id: sessionId,
        name: 'campaign',
        created_at: '2026-08-27T09:00:00Z',
        updated_at: '2026-08-27T09:30:00Z',
        draft: null
      }),
    () => client.getSessionDetail('tok', sessionId)
  )
  assert.ok(withoutDraft.outcome === 'succeeded')
  assert.equal(withoutDraft.value.draft, null)
})

test('draft responses with unknown shapes fail closed', async () => {
  const client = createCreationClient(serverUrl)

  const unknownRole = await withFetch(
    () =>
      jsonResponse({
        id: sessionId,
        name: 'campaign',
        created_at: '2026-08-27T09:00:00Z',
        updated_at: '2026-08-27T09:30:00Z',
        draft: {
          prompt: '',
          media_type: 'image',
          manifest_version: 1,
          updated_at: '2026-08-29T10:00:00Z',
          model: null,
          mode: null,
          ratio: null,
          resolution: null,
          quantity: null,
          duration_seconds: null,
          references: [{ material_id: 'cccccccc-0000-4000-8000-000000000003', role: 'hero' }]
        }
      }),
    () => client.getSessionDetail('tok', sessionId)
  )
  assert.equal(unknownRole.outcome, 'network-failure')

  const missingField = await withFetch(
    () =>
      jsonResponse({
        id: sessionId,
        name: 'campaign',
        created_at: '2026-08-27T09:00:00Z',
        updated_at: '2026-08-27T09:30:00Z',
        draft: { prompt: '', manifest_version: 1, references: [] }
      }),
    () => client.getSessionDetail('tok', sessionId)
  )
  assert.equal(missingField.outcome, 'network-failure')
})
