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

const { createAssetLibraryClient } =
  await import('../../src/renderer/src/features/creation/api/asset-library-http.ts')

const serverUrl = 'https://server.example'
const imageBytes = new TextEncoder().encode('verified-image')
const checksum = Buffer.from(await crypto.subtle.digest('SHA-256', imageBytes)).toString('hex')

const asset = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  creator: { id: 'user-one', display_name: 'Aster' },
  media_type: 'image',
  mime_type: 'image/png',
  byte_size: imageBytes.byteLength,
  checksum_sha256: checksum,
  width_px: 1200,
  height_px: 800,
  duration_ms: null,
  created_at: '2026-09-16T08:00:00Z',
  restricted: false,
  restriction_state: null,
  publication: null,
  capabilities: {
    can_delete: true,
    can_create_similar: true,
    can_publish: true,
    can_restrict: true,
    can_release: false
  }
}

const facets = {
  modes: ['text-to-image', 'reference-image'],
  ratios: ['16:9', '1:1'],
  resolutions: ['1K', '2K']
}

test('asset list sends the accepted keyset filters and decodes public facts', async () => {
  const originalFetch = globalThis.fetch
  let requested: URL | undefined
  globalThis.fetch = async (input) => {
    requested = new URL(String(input))
    return Response.json({ assets: [asset], next_cursor: 'next-page', facets })
  }
  try {
    const result = await createAssetLibraryClient(serverUrl).list('token', {
      cursor: 'cursor-one',
      mediaType: 'image',
      createdSince: '2026-09-01T00:00:00Z',
      createdUntil: '2026-09-11T00:00:00Z',
      sort: 'oldest',
      modes: ['text-to-image', 'reference-image'],
      ratios: ['16:9'],
      resolutions: ['2K', '1K'],
      limit: 24
    })
    assert.equal(result.outcome, 'succeeded')
    if (result.outcome !== 'succeeded') return
    assert.deepEqual(result.value.assets[0], {
      id: asset.id,
      creator: { id: 'user-one', displayName: 'Aster' },
      mediaType: 'image',
      mimeType: 'image/png',
      byteSize: imageBytes.byteLength,
      checksumSha256: checksum,
      widthPx: 1200,
      heightPx: 800,
      durationMs: null,
      createdAt: '2026-09-16T08:00:00Z',
      restricted: false,
      restrictionState: null,
      publication: null,
      capabilities: {
        canDelete: true,
        canCreateSimilar: true,
        canPublish: true,
        canRestrict: true,
        canRelease: false
      }
    })
    assert.equal(result.value.nextCursor, 'next-page')
    assert.deepEqual(result.value.facets, facets)
    assert.deepEqual(Object.fromEntries(requested?.searchParams ?? []), {
      cursor: 'cursor-one',
      media_type: 'image',
      created_since: '2026-09-01T00:00:00Z',
      created_until: '2026-09-11T00:00:00Z',
      sort: 'oldest',
      limit: '24',
      // Repeated parameters collapse to their last value here; `getAll` below
      // checks the repetition itself.
      mode: 'reference-image',
      ratio: '16:9',
      resolution: '1K'
    })
    // Each facet repeats its own parameter, in the order the caller chose.
    assert.deepEqual(requested?.searchParams.getAll('mode'), ['text-to-image', 'reference-image'])
    assert.deepEqual(requested?.searchParams.getAll('ratio'), ['16:9'])
    assert.deepEqual(requested?.searchParams.getAll('resolution'), ['2K', '1K'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('asset list keeps publication and safety restriction as independent facts', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    Response.json({
      assets: [
        {
          ...asset,
          restricted: true,
          restriction_state: 'active',
          publication: {
            id: 'publication-one',
            published_at: '2026-09-17T08:00:00Z',
            restricted: true,
            restriction_state: 'active'
          }
        }
      ],
      next_cursor: null,
      facets: null
    })
  try {
    const result = await createAssetLibraryClient(serverUrl).list('token', {})
    assert.equal(result.outcome, 'succeeded')
    if (result.outcome !== 'succeeded') return
    // An unpinned media has no vocabulary to offer, and that is not a failure.
    assert.equal(result.value.facets, null)
    assert.equal(result.value.assets[0].restricted, true)
    assert.equal(result.value.assets[0].restrictionState, 'active')
    assert.deepEqual(result.value.assets[0].publication, {
      id: 'publication-one',
      publishedAt: '2026-09-17T08:00:00Z',
      restricted: true,
      restrictionState: 'active'
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('asset detail exposes private origin only when the server supplies it', async () => {
  const originalFetch = globalThis.fetch
  const privateOrigin = {
    session_id: 'session-one',
    task_id: 'task-one',
    slot_index: 0,
    specification: {
      schema_version: 1,
      media_type: 'image',
      prompt: 'A quiet launch scene',
      model: 'doubao-seedream-5.0-pro',
      mode: 'text-to-image',
      manifest_version: 7,
      ratio: '3:2',
      resolution: '2K',
      quantity: 1,
      duration_seconds: null,
      references: [
        { material_id: 'material-one', role: 'reference', kind: 'image', claims_version: 1 }
      ]
    },
    references: [
      {
        id: 'material-one',
        role: 'reference',
        kind: 'image',
        file_name: 'reference.png',
        mime_type: 'image/png',
        byte_size: 512,
        width_px: 100,
        height_px: 80,
        duration_ms: null,
        claims_version: 1
      }
    ]
  }
  globalThis.fetch = async () =>
    Response.json({
      asset,
      siblings: [{ ...asset, id: 'bbbbbbbb-0000-4000-8000-000000000002' }],
      private_origin: privateOrigin
    })
  try {
    const result = await createAssetLibraryClient(serverUrl).get('token', asset.id)
    assert.equal(result.outcome, 'succeeded')
    if (result.outcome !== 'succeeded') return
    assert.equal(result.value.siblings[0].id, 'bbbbbbbb-0000-4000-8000-000000000002')
    assert.deepEqual(result.value.privateOrigin, {
      sessionId: 'session-one',
      sessionName: null,
      taskId: 'task-one',
      slotIndex: 0,
      specification: {
        schemaVersion: 1,
        mediaType: 'image',
        prompt: 'A quiet launch scene',
        model: 'doubao-seedream-5.0-pro',
        mode: 'text-to-image',
        manifestVersion: 7,
        ratio: '3:2',
        resolution: '2K',
        quantity: 1,
        durationSeconds: null,
        references: [
          { materialId: 'material-one', role: 'reference', kind: 'image', claimsVersion: 1 }
        ]
      },
      references: [
        {
          id: 'material-one',
          role: 'reference',
          kind: 'image',
          fileName: 'reference.png',
          mimeType: 'image/png',
          byteSize: 512,
          widthPx: 100,
          heightPx: 80,
          durationMs: null,
          claimsVersion: 1
        }
      ]
    })

    globalThis.fetch = async () => Response.json({ asset, siblings: [] })
    const publicResult = await createAssetLibraryClient(serverUrl).get('token', asset.id)
    assert.equal(publicResult.outcome, 'succeeded')
    if (publicResult.outcome === 'succeeded') {
      assert.equal(publicResult.value.privateOrigin, null)
    }

    globalThis.fetch = async () =>
      Response.json({
        asset,
        siblings: [],
        private_origin: { ...privateOrigin, session_name: 7 }
      })
    assert.deepEqual(await createAssetLibraryClient(serverUrl).get('token', asset.id), {
      outcome: 'network-failure'
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('asset content verifies the trusted checksum before returning bytes', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(imageBytes, {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'X-Content-SHA-256': checksum }
    })
  try {
    const client = createAssetLibraryClient(serverUrl)
    const verified = await client.downloadContent('token', asset.id, checksum)
    assert.equal(verified.outcome, 'succeeded')

    const mismatched = new Response(imageBytes, {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'X-Content-SHA-256': '00'.repeat(32) }
    })
    globalThis.fetch = async () => mismatched
    const rejected = await client.downloadContent('token', asset.id, checksum)
    assert.deepEqual(rejected, { outcome: 'request-rejected', code: 'checksum_mismatch' })
    assert.equal(mismatched.bodyUsed, false)

    globalThis.fetch = async () =>
      new Response(imageBytes, {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'X-Content-SHA-256': checksum }
      })
    assert.deepEqual(
      await client.downloadContent('token', asset.id, checksum, {
        expectedByteSize: imageBytes.byteLength + 1
      }),
      { outcome: 'request-rejected', code: 'byte_size_mismatch' }
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('asset content maps aborts to the stable download cancellation code', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError'))
      )
    })
    throw new Error('unreachable')
  }
  try {
    const controller = new AbortController()
    const pending = createAssetLibraryClient(serverUrl).downloadContent(
      'token',
      asset.id,
      checksum,
      {
        signal: controller.signal
      }
    )
    controller.abort()
    assert.deepEqual(await pending, { outcome: 'request-rejected', code: 'download_cancelled' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a display read asks the fixed variant endpoint per purpose and returns one exact grant', async () => {
  const originalFetch = globalThis.fetch
  const requested: string[] = []
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
  globalThis.fetch = async (input) => {
    const url = input instanceof URL ? input : new URL(String(input))
    requested.push(`${url.pathname}${url.search}`)
    return new Response(
      JSON.stringify({
        url: 'https://bucket.example/signed?x-oss-process=w_320',
        expires_at: expiresAt
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }
  try {
    const client = createAssetLibraryClient(serverUrl)
    const thumbnail = await client.loadDisplay('token', asset.id, 'thumbnail')
    const preview = await client.loadDisplay('token', asset.id, 'preview')
    assert.deepEqual(thumbnail, {
      outcome: 'succeeded',
      value: { url: 'https://bucket.example/signed?x-oss-process=w_320', expiresAt }
    })
    assert.equal(preview.outcome, 'succeeded')
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(requested, [
    `/creation/assets/${asset.id}/thumbnail-url`,
    `/creation/assets/${asset.id}/preview-url`
  ])
})

test('a display read maps a gone asset, a refusal, and a dead grant apart', async () => {
  const originalFetch = globalThis.fetch
  const client = createAssetLibraryClient(serverUrl)
  const answer = async (status: number, payload?: unknown): Promise<unknown> => {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(payload === undefined ? null : JSON.stringify(payload), { status })
    return client.loadDisplay('token', asset.id, 'preview')
  }
  try {
    assert.deepEqual(await answer(404, { error: 'not_found' }), {
      outcome: 'request-rejected',
      code: 'not_found'
    })
    assert.deepEqual(await answer(403, { error: 'forbidden' }), { outcome: 'forbidden' })
    assert.deepEqual(await answer(401, { error: 'unauthorized' }), { outcome: 'unauthorized' })
    assert.deepEqual(await answer(500), { outcome: 'network-failure' })
    // A grant that is already dead, or not an absolute HTTPS URL, is a failed
    // read: the renderer must not hand it to a media element.
    assert.deepEqual(
      await answer(200, { url: 'https://bucket.example/x', expires_at: '2020-01-01T00:00:00Z' }),
      { outcome: 'network-failure' }
    )
    assert.deepEqual(
      await answer(200, {
        url: 'http://bucket.example/x',
        expires_at: new Date(Date.now() + 60_000).toISOString()
      }),
      { outcome: 'network-failure' }
    )
    assert.deepEqual(await answer(200, { url: 'https://bucket.example/x' }), {
      outcome: 'network-failure'
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('asset delete accepts the contract 204 response without parsing an absent body', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 204 })
  try {
    assert.deepEqual(await createAssetLibraryClient(serverUrl).delete('token', asset.id), {
      outcome: 'succeeded',
      value: undefined
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
