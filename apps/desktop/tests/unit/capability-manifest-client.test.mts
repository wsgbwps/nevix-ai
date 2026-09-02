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
  models: [
    {
      model: 'doubao-seedream-5.0-pro',
      resolutions: ['1K', '1.5K', '2K'],
      default_resolution: '2K',
      max_reference_images: 10,
      sizes: [
        { resolution: '1K', ratio: '1:1', width: 1024, height: 1024 },
        { resolution: '2K', ratio: '4:3', width: 2368, height: 1776 }
      ]
    },
    {
      model: 'doubao-seedream-5.0',
      resolutions: ['2K', '3K', '4K'],
      default_resolution: '2K'
    }
  ],
  modes: [
    { id: 'text-to-image', reference_material: { total: { min: 0, max: 0 } } },
    { id: 'reference-image', reference_material: { total: { min: 1, max: 4 } } }
  ],
  ratios: ['1:1', '4:3'],
  quantities: [1, 2],
  defaults: { ratio: '1:1', quantity: 1 },
  prompt: { min_chars: 1, max_chars: 2000 },
  reference_material: { total: { min: 0, max: 4 } }
}

const availableVideo = {
  available: true,
  models: [
    {
      model: 'doubao-seedance-2-5',
      resolutions: ['480p', '720p', '1080p'],
      default_resolution: '720p'
    }
  ],
  modes: [
    {
      id: 'first-last-frame',
      reference_material: {
        total: { min: 1, max: 2 },
        per_media: {
          image: {
            count: { min: 1, max: 2 },
            formats: ['jpeg', 'png', 'webp'],
            max_bytes: 10485760,
            min_px: 256,
            max_px: 6000,
            max_pixels: 36000000,
            min_aspect: 0.3333,
            max_aspect: 3
          }
        }
      }
    },
    {
      id: 'omni-reference',
      reference_material: {
        total: { min: 1, max: 4 },
        per_media: {
          video: {
            count: { min: 0, max: 1 },
            formats: ['mp4'],
            max_bytes: 209715200,
            min_seconds: 2,
            max_seconds: 30
          },
          audio: {
            count: { min: 0, max: 1 },
            formats: ['mp3', 'wav', 'm4a'],
            max_bytes: 52428800,
            min_seconds: 2,
            max_seconds: 30
          }
        }
      }
    }
  ],
  durations: [5],
  defaults: { duration: 5 },
  prompt: { min_chars: 1, max_chars: 2000 },
  reference_material: { total: { min: 0, max: 4 } }
}

const pendingVideo = {
  available: false,
  reason: 'not_configured',
  action: 'contact_admin'
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

  it('parses available and connection-unavailable media into structured views', async () => {
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
        assert.deepEqual(
          result.value.image.models?.map((model) => model.model),
          ['doubao-seedream-5.0-pro', 'doubao-seedream-5.0']
        )
        assert.deepEqual(result.value.image.models?.[0].resolutions, ['1K', '1.5K', '2K'])
        assert.equal(result.value.image.models?.[0].defaultResolution, '2K')
        // The published pixel sizes arrive verbatim; a model without them
        // (video) simply carries no sizes.
        assert.deepEqual(result.value.image.models?.[0].sizes, [
          { resolution: '1K', ratio: '1:1', width: 1024, height: 1024 },
          { resolution: '2K', ratio: '4:3', width: 2368, height: 1776 }
        ])
        assert.equal(result.value.image.models?.[1].sizes, undefined)
        // The per-model reference ceiling rides the model view; video (and
        // models without one) simply carries none.
        assert.equal(result.value.image.models?.[0].maxReferenceImages, 10)
        assert.equal(result.value.image.models?.[1].maxReferenceImages, undefined)
        assert.deepEqual(
          result.value.image.modes?.map((mode) => mode.id),
          ['text-to-image', 'reference-image']
        )
        assert.deepEqual(result.value.image.defaults, {
          ratio: '1:1',
          quantity: 1,
          duration: undefined
        })
        assert.equal(result.value.video.available, false)
        assert.equal(result.value.video.reason, 'not_configured')
        assert.equal(result.value.video.action, 'contact_admin')
        assert.equal(result.value.video.models, undefined)
      }
    )
  })

  it('mirrors prompt and per-media reference envelopes for the composer', async () => {
    await withFetch(
      () =>
        Promise.resolve(
          jsonResponse({
            schema_version: 1,
            manifest_version: 1,
            image: availableImage,
            video: availableVideo
          })
        ),
      async () => {
        const client = createCapabilityManifestClient(serverUrl)
        const result = await client.lookup('token-a')
        assert.equal(result.outcome, 'succeeded')
        if (result.outcome !== 'succeeded') return
        assert.deepEqual(result.value.image.prompt, { minChars: 1, maxChars: 2000 })
        const omni = result.value.video.modes?.find((mode) => mode.id === 'omni-reference')
        assert.ok(omni)
        assert.deepEqual(omni.referenceMaterial.video, {
          count: { min: 0, max: 1 },
          formats: ['mp4'],
          maxBytes: 209715200,
          minSeconds: 2,
          maxSeconds: 30
        })
        assert.deepEqual(omni.referenceMaterial.audio?.formats, ['mp3', 'wav', 'm4a'])
        const firstLast = result.value.video.modes?.find((mode) => mode.id === 'first-last-frame')
        assert.equal(firstLast?.referenceMaterial.image?.maxBytes, 10485760)
        assert.equal(firstLast?.referenceMaterial.video, undefined)
      }
    )
  })

  it('rejects a malformed optional list instead of reading a smaller set', () => {
    // A corrupted ratios array must fail closed, not silently parse as "no
    // ratios published".
    const corrupted = parseCapabilityManifest({
      schema_version: 1,
      manifest_version: 1,
      image: { ...availableImage, ratios: 'everything' },
      video: pendingVideo
    })
    assert.equal(corrupted, null)
    // A malformed per_media envelope fails the whole payload too.
    const badEnvelope = parseCapabilityManifest({
      schema_version: 1,
      manifest_version: 1,
      image: availableImage,
      video: {
        ...availableVideo,
        modes: [
          {
            id: 'first-last-frame',
            reference_material: {
              total: { min: 1, max: 2 },
              per_media: { image: { count: 'two' } }
            }
          }
        ]
      }
    })
    assert.equal(badEnvelope, null)
    // A malformed per-model reference ceiling fails the whole payload too.
    const proWithBadCeiling = (ceiling: unknown): unknown => ({
      schema_version: 1,
      manifest_version: 1,
      image: {
        ...availableImage,
        models: [{ ...availableImage.models[0], max_reference_images: ceiling }]
      },
      video: pendingVideo
    })
    assert.equal(parseCapabilityManifest(proWithBadCeiling('ten')), null)
    assert.equal(parseCapabilityManifest(proWithBadCeiling(0)), null)
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
        image: { available: false, reason: 'kapon_says_meh', action: 'contact_admin' },
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
    // A model whose default resolution is outside its own tier set fails
    // closed — the composer may never seed an unsubmittable resolution.
    assert.equal(
      parseCapabilityManifest({
        schema_version: 1,
        manifest_version: 1,
        image: {
          ...availableImage,
          models: [
            {
              model: 'doubao-seedream-5.0-pro',
              resolutions: ['1K', '1.5K', '2K'],
              default_resolution: '4K'
            }
          ]
        },
        video: pendingVideo
      }),
      null
    )
    // A pixel size outside the model's own tiers, outside the published
    // ratios, or with a non-positive dimension fails closed: display data
    // must never impersonate a capability.
    const sizeCases: Array<Record<string, unknown>> = [
      { resolution: '4K', ratio: '1:1', width: 4096, height: 4096 },
      { resolution: '1K', ratio: '9:16', width: 800, height: 1424 },
      { resolution: '1K', ratio: '1:1', width: 0, height: 1024 },
      { resolution: '1K', ratio: '1:1', width: 'wide', height: 1024 }
    ]
    for (const sizes of sizeCases) {
      assert.equal(
        parseCapabilityManifest({
          schema_version: 1,
          manifest_version: 1,
          image: {
            ...availableImage,
            models: [
              {
                model: 'doubao-seedream-5.0-pro',
                resolutions: ['1K', '1.5K', '2K'],
                default_resolution: '2K',
                sizes: [sizes]
              }
            ]
          },
          video: pendingVideo
        }),
        null,
        `sizes entry must fail closed: ${JSON.stringify(sizes)}`
      )
    }
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

function pendingImage(): {
  available: boolean
  reason: string
  action: string
} {
  return { available: false, reason: 'not_configured', action: 'contact_admin' }
}
