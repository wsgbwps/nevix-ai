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

const { createCapabilityManifestClient, parseCapabilityManifest } =
  await import('../../src/renderer/src/features/creation/api/capability-manifest-http.ts')

/**
 * Unit coverage for the Capability Manifest client (issue #158): the exact
 * contract path/method/Bearer mechanics, structured availability parsing,
 * and fail-closed behavior on unknown or malformed payloads — a consumer
 * must never guess a provider verdict from an unexpected shape.
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

const availableImage = {
  available: true,
  model: 'doubao-seedream-5.0-lite',
  modes: [
    { id: 'text-to-image', reference_material: { total: { min: 0, max: 0 } } },
    { id: 'reference-image', reference_material: { total: { min: 1, max: 4 } } }
  ],
  ratios: ['1:1', '4:3'],
  resolutions: ['1K', '2K'],
  quantities: [1, 2],
  defaults: { ratio: '1:1', resolution: '2K', quantity: 1 },
  prompt: { min_chars: 1, max_chars: 2000 },
  reference_material: { total: { min: 0, max: 4 } }
}

const pendingVideo = {
  available: false,
  reason: 'production_readiness_pending',
  action: 'await_release'
}

describe('capability manifest client', () => {
  it('sends GET /creation/capability-manifest with the Bearer token', async () => {
    const requests: Request[] = []
    await withFetch(
      (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        return Promise.resolve(
          jsonResponse({
            schema_version: 1,
            manifest_version: 1,
            image: pendingImage(),
            video: pendingVideo
          })
        )
      },
      async () => {
        const client = createCapabilityManifestClient(serverUrl)
        const result = await client.lookup('token-a')
        assert.equal(result.outcome, 'succeeded')
      }
    )
    assert.deepEqual(
      requests.map((request) => [request.method, new URL(request.url).pathname]),
      [['GET', '/creation/capability-manifest']]
    )
    assert.equal(requests[0].headers.get('Authorization'), 'Bearer token-a')
  })

  it('parses available and readiness-pending media into structured views', async () => {
    await withFetch(
      () =>
        Promise.resolve(
          jsonResponse({
            schema_version: 1,
            manifest_version: 3,
            image: availableImage,
            video: pendingVideo
          })
        ),
      async () => {
        const client = createCapabilityManifestClient(serverUrl)
        const result = await client.lookup('token-a')
        assert.equal(result.outcome, 'succeeded')
        if (result.outcome !== 'succeeded') return
        assert.equal(result.value.schemaVersion, 1)
        assert.equal(result.value.manifestVersion, 3)
        assert.equal(result.value.image.available, true)
        assert.equal(result.value.image.model, 'doubao-seedream-5.0-lite')
        assert.deepEqual(result.value.image.modes?.map((mode) => mode.id), [
          'text-to-image',
          'reference-image'
        ])
        assert.deepEqual(result.value.image.defaults, {
          ratio: '1:1',
          resolution: '2K',
          quantity: 1,
          duration: undefined
        })
        assert.equal(result.value.video.available, false)
        assert.equal(result.value.video.reason, 'production_readiness_pending')
        assert.equal(result.value.video.action, 'await_release')
        assert.equal(result.value.video.model, undefined)
      }
    )
  })

  it('maps stable failures without inventing verdicts', async () => {
    await withFetch(
      () => Promise.resolve(jsonResponse({ error: 'unauthorized', message: 'no' }, 401)),
      async () => {
        const client = createCapabilityManifestClient(serverUrl)
        const unauthorized = await client.lookup('token-a')
        assert.deepEqual(unauthorized, { outcome: 'unauthorized' })
      }
    )
    await withFetch(
      () => Promise.reject(new TypeError('network down')),
      async () => {
        const client = createCapabilityManifestClient(serverUrl)
        const failure = await client.lookup('token-a')
        assert.deepEqual(failure, { outcome: 'network-failure' })
      }
    )
  })

  it('fails closed on malformed or unknown wire shapes', () => {
    assert.equal(parseCapabilityManifest(null), null)
    assert.equal(parseCapabilityManifest('nope'), null)
    assert.equal(parseCapabilityManifest({}), null)

    // An unknown reason must never parse into a verdict.
    assert.equal(
      parseCapabilityManifest({
        schema_version: 1,
        manifest_version: 1,
        image: { available: false, reason: 'kapon_says_meh', action: 'await_release' },
        video: pendingVideo
      }),
      null
    )
    // An unknown action is equally untrustworthy.
    assert.equal(
      parseCapabilityManifest({
        schema_version: 1,
        manifest_version: 1,
        image: { available: false, reason: 'not_configured', action: 'yell_at_admin' },
        video: pendingVideo
      }),
      null
    )
    // An available media without values fails closed.
    assert.equal(
      parseCapabilityManifest({
        schema_version: 1,
        manifest_version: 1,
        image: { available: true },
        video: pendingVideo
      }),
      null
    )
    // A truncated payload (missing video) fails closed.
    assert.equal(
      parseCapabilityManifest({ schema_version: 1, manifest_version: 1, image: availableImage }),
      null
    )
  })

  it('keeps stale draft values usable against the structured reason', async () => {
    // The contract's draft-staleness semantics: an unavailable media exposes
    // only reason/action, so the Workbench retains the draft's original
    // values and blocks submission — nothing here rewrites intent.
    const manifest = parseCapabilityManifest({
      schema_version: 1,
      manifest_version: 1,
      image: availableImage,
      video: { available: false, reason: 'connection_paused', action: 'contact_admin' }
    })
    assert.ok(manifest)
    assert.equal(manifest.video.available, false)
    assert.equal(manifest.video.reason, 'connection_paused')
    assert.equal(manifest.video.quantities, undefined)
    assert.equal(manifest.video.defaults, undefined)
  })
})

function pendingImage() {
  return { available: false, reason: 'production_readiness_pending', action: 'await_release' }
}
