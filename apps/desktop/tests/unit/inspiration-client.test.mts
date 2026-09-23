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

const { createInspirationClient } =
  await import('../../src/renderer/src/features/creation/api/inspiration-http.ts')

const serverUrl = 'https://server.example'
const publication = {
  id: 'publication-one',
  source_asset_id: 'asset-one',
  publisher: { id: 'publisher-one', display_name: 'Aster' },
  media_type: 'image',
  mime_type: 'image/png',
  byte_size: 123,
  checksum_sha256: 'aa'.repeat(32),
  width_px: 1200,
  height_px: 800,
  duration_ms: null,
  published_at: '2026-09-17T08:00:00Z',
  restricted: false,
  restriction_state: null,
  capabilities: {
    can_withdraw: true,
    can_create_similar: true,
    can_restrict: true,
    can_release: false
  }
}

const asset = {
  id: 'asset-one',
  creator: { id: 'publisher-one', display_name: 'Aster' },
  media_type: 'image',
  mime_type: 'image/png',
  byte_size: 123,
  checksum_sha256: 'aa'.repeat(32),
  width_px: 1200,
  height_px: 800,
  duration_ms: null,
  created_at: '2026-09-17T07:00:00Z',
  restricted: true,
  restriction_state: 'active',
  publication: null,
  capabilities: {
    can_delete: true,
    can_create_similar: false,
    can_publish: false,
    can_restrict: false,
    can_release: true
  }
}

const specification = {
  schema_version: 1,
  media_type: 'image',
  prompt: 'Preserve this archived intent',
  model: 'archived-model',
  mode: 'reference-image',
  manifest_version: 2,
  ratio: '3:2',
  resolution: '2K',
  quantity: 1,
  duration_seconds: null,
  references: [{ material_id: 'new-material', role: 'reference', kind: 'image', claims_version: 1 }]
}

test('inspiration list sends one filter set and strictly decodes heterogeneous items', async () => {
  const originalFetch = globalThis.fetch
  let requested: URL | undefined
  globalThis.fetch = async (input) => {
    requested = new URL(String(input))
    return Response.json({
      items: [{ type: 'publication', publication }],
      next_cursor: 'next-page'
    })
  }
  try {
    const result = await createInspirationClient(serverUrl).list('token', {
      cursor: 'cursor-one',
      mediaType: 'image',
      creator: ' Aster ',
      search: 'publication-one',
      limit: 24
    })
    assert.equal(result.outcome, 'succeeded')
    if (result.outcome !== 'succeeded') return
    assert.deepEqual(result.value.items[0], {
      type: 'publication',
      publication: {
        id: 'publication-one',
        sourceAssetId: 'asset-one',
        publisher: { id: 'publisher-one', displayName: 'Aster' },
        mediaType: 'image',
        mimeType: 'image/png',
        byteSize: 123,
        checksumSha256: 'aa'.repeat(32),
        widthPx: 1200,
        heightPx: 800,
        durationMs: null,
        publishedAt: '2026-09-17T08:00:00Z',
        restricted: false,
        restrictionState: null,
        capabilities: {
          canWithdraw: true,
          canCreateSimilar: true,
          canRestrict: true,
          canRelease: false
        }
      }
    })
    assert.deepEqual(Object.fromEntries(requested?.searchParams ?? []), {
      cursor: 'cursor-one',
      media_type: 'image',
      creator: 'Aster',
      search: 'publication-one',
      limit: '24'
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('publication Create Similar sends the desktop key and preserves remapped stale intent', async () => {
  const originalFetch = globalThis.fetch
  let body: unknown
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body))
    return Response.json({
      session: {
        id: 'session-one',
        name: 'Aster publication',
        created_at: '2026-09-17T08:00:00Z',
        updated_at: '2026-09-17T08:00:00Z'
      },
      materials: [
        {
          id: 'new-material',
          session_id: 'session-one',
          kind: 'image',
          file_name: 'reference.png',
          mime_type: 'image/png',
          byte_size: 42,
          checksum_sha256: 'bb'.repeat(32),
          width_px: 100,
          height_px: 100,
          duration_ms: null,
          claims_version: 1,
          created_at: '2026-09-17T08:00:00Z'
        }
      ],
      specification,
      submission_blocked: true
    })
  }
  try {
    const result = await createInspirationClient(serverUrl).createSimilar(
      'token',
      publication.id,
      'desktop-key'
    )
    assert.deepEqual(body, { idempotency_key: 'desktop-key' })
    assert.equal(result.outcome, 'succeeded')
    if (result.outcome !== 'succeeded') return
    assert.equal(result.value.session.id, 'session-one')
    assert.equal(result.value.specification.model, 'archived-model')
    assert.deepEqual(result.value.specification.references, [
      { materialId: 'new-material', role: 'reference', kind: 'image', claimsVersion: 1 }
    ])
    assert.equal(result.value.submissionBlocked, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('publication Create Similar rejects materials outside the returned Session', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    Response.json({
      session: {
        id: 'session-one',
        name: 'Aster publication',
        created_at: '2026-09-17T08:00:00Z',
        updated_at: '2026-09-17T08:00:00Z'
      },
      materials: [
        {
          id: 'new-material',
          session_id: 'different-session',
          kind: 'image',
          file_name: 'reference.png',
          mime_type: 'image/png',
          byte_size: 42,
          checksum_sha256: 'bb'.repeat(32),
          width_px: 100,
          height_px: 100,
          duration_ms: null,
          claims_version: 1,
          created_at: '2026-09-17T08:00:00Z'
        }
      ],
      specification,
      submission_blocked: true
    })
  try {
    assert.deepEqual(
      await createInspirationClient(serverUrl).createSimilar(
        'token',
        publication.id,
        'desktop-key'
      ),
      { outcome: 'network-failure' }
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('publication mutations use their exact paths and narrow response envelopes', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ readonly path: string; readonly method: string }> = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push({ path: url.pathname, method: init?.method ?? 'GET' })
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    return Response.json({ publication })
  }
  try {
    const client = createInspirationClient(serverUrl)
    assert.equal((await client.publish('token', 'asset-one', 'publish-key')).outcome, 'succeeded')
    assert.equal((await client.withdraw('token', 'publication-one')).outcome, 'succeeded')
    assert.deepEqual(calls, [
      { path: '/creation/assets/asset-one/publication', method: 'POST' },
      { path: '/creation/publications/publication-one', method: 'DELETE' }
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("a display grant follows the item's own identity, not one shared path", async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    calls.push(url.pathname)
    return Response.json({ url: 'https://bucket.example/signed', expires_at: expiresAt })
  }
  try {
    const client = createInspirationClient(serverUrl)
    const thumbnail = await client.loadDisplay(
      'token',
      { type: 'publication', publication: { ...publication, id: 'publication one' } },
      'thumbnail'
    )
    assert.deepEqual(thumbnail, {
      outcome: 'succeeded',
      value: { url: 'https://bucket.example/signed', expiresAt }
    })
    await client.loadDisplay(
      'token',
      { type: 'asset', asset: { ...asset, id: 'asset one' } },
      'preview'
    )
    // A Publication and an Admin-governed Asset are different identities: one
    // shared path would authorize the wrong record.
    assert.deepEqual(calls, [
      '/creation/publications/publication%20one/thumbnail-url',
      '/creation/inspiration/assets/asset%20one/preview-url'
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('admin safety mutations use exact item restriction paths and strictly decode state', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ readonly path: string; readonly method: string }> = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push({ path: url.pathname, method: init?.method ?? 'GET' })
    const released = init?.method === 'DELETE'
    const activePublication = {
      ...publication,
      restricted: !released,
      restriction_state: released ? 'released' : 'active',
      capabilities: {
        ...publication.capabilities,
        can_withdraw: false,
        can_create_similar: false,
        can_restrict: released,
        can_release: !released
      }
    }
    return Response.json(
      url.pathname.includes('/inspiration/assets/')
        ? {
            asset: released
              ? {
                  ...asset,
                  restricted: false,
                  restriction_state: 'released',
                  capabilities: {
                    ...asset.capabilities,
                    can_restrict: true,
                    can_release: false
                  }
                }
              : asset
          }
        : { publication: activePublication }
    )
  }
  try {
    const client = createInspirationClient(serverUrl)
    assert.equal((await client.restrictAsset('token', 'asset one')).outcome, 'succeeded')
    const releasedAsset = await client.releaseAsset('token', 'asset one')
    assert.equal(releasedAsset.outcome, 'succeeded')
    if (releasedAsset.outcome === 'succeeded') {
      assert.equal(releasedAsset.value.restrictionState, 'released')
    }
    const restricted = await client.restrictPublication('token', 'publication one')
    assert.equal(restricted.outcome, 'succeeded')
    if (restricted.outcome === 'succeeded') {
      assert.equal(restricted.value.restrictionState, 'active')
      assert.deepEqual(restricted.value.capabilities, {
        canWithdraw: false,
        canCreateSimilar: false,
        canRestrict: false,
        canRelease: true
      })
    }
    const releasedPublication = await client.releasePublication('token', 'publication one')
    assert.equal(releasedPublication.outcome, 'succeeded')
    if (releasedPublication.outcome === 'succeeded') {
      assert.equal(releasedPublication.value.restrictionState, 'released')
      assert.equal(releasedPublication.value.capabilities.canCreateSimilar, false)
    }
    assert.deepEqual(calls, [
      { path: '/creation/inspiration/assets/asset%20one/restriction', method: 'PUT' },
      { path: '/creation/inspiration/assets/asset%20one/restriction', method: 'DELETE' },
      { path: '/creation/publications/publication%20one/restriction', method: 'PUT' },
      { path: '/creation/publications/publication%20one/restriction', method: 'DELETE' }
    ])

    globalThis.fetch = async () =>
      Response.json({
        publication: { ...publication, restriction_state: 'unknown' }
      })
    assert.deepEqual(await client.restrictPublication('token', 'publication-one'), {
      outcome: 'network-failure'
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
