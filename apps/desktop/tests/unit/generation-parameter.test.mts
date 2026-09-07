import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import type {
  CapabilityManifest,
  CapabilityMedia
} from '../../src/renderer/src/features/creation/api/capability-manifest-http.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isDesktopSource = context.parentURL?.includes('/apps/desktop/src/') === true
    const resolvedSpecifier =
      isDesktopSource && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)
        ? `${specifier}.ts`
        : specifier
    return nextResolve(resolvedSpecifier)
  }
})

const {
  generationParameterWireValues,
  parseGenerationParameterValues,
  manifestDefaultParameters,
  emptyGenerationParameters,
  publishedParameterRules,
  GENERATION_PARAMETER_WIRE_KEYS
} = await import('../../src/renderer/src/features/creation/api/generation-parameter.ts')
const { staleDraftFields } =
  await import('../../src/renderer/src/features/creation/model/capability.ts')
const { readLocalDraft } =
  await import('../../src/renderer/src/features/creation/model/draft-store.ts')

const fullValues = {
  mediaType: 'video',
  model: 'doubao-seedance-2.5',
  mode: 'first-last-frame',
  ratio: '16:9',
  resolution: '1080p',
  quantity: null,
  durationSeconds: 10
} as const

test('a full parameter set round-trips through its wire projection', () => {
  const wire = generationParameterWireValues(fullValues)
  assert.deepEqual(wire, {
    media_type: 'video',
    model: 'doubao-seedance-2.5',
    mode: 'first-last-frame',
    ratio: '16:9',
    resolution: '1080p',
    quantity: null,
    duration_seconds: 10
  })
  assert.deepEqual(parseGenerationParameterValues({ ...wire }), fullValues)
})

test('a wire payload missing parameter fields reads them as null (ADR-0017 revision)', () => {
  const legacy = {
    media_type: 'image',
    model: 'doubao-seedream-5.0-pro',
    ratio: '4:3'
  }
  assert.deepEqual(parseGenerationParameterValues(legacy), {
    ...emptyGenerationParameters(),
    mediaType: 'image',
    model: 'doubao-seedream-5.0-pro',
    ratio: '4:3'
  })
})

test('a present value of the wrong shape rejects the whole set', () => {
  const good = generationParameterWireValues(fullValues)
  assert.equal(parseGenerationParameterValues({ ...good, quantity: 'two' }), null)
  assert.equal(parseGenerationParameterValues({ ...good, ratio: 21 }), null)
  assert.equal(parseGenerationParameterValues({ ...good, media_type: 'gif' }), null)
  assert.equal(parseGenerationParameterValues({ ...good, duration_seconds: Number.NaN }), null)
})

const imageCapability: CapabilityMedia = {
  available: true,
  reason: null,
  action: null,
  models: [
    { model: 'doubao-seedream-5.0-pro', resolutions: ['2K', '4K'], defaultResolution: '2K' }
  ],
  modes: [{ id: 'text-to-image', referenceMaterial: { total: { min: 0, max: 4 } } }],
  ratios: ['1:1', '4:3', '16:9'],
  quantities: [1, 2, 4],
  defaults: { ratio: '4:3', quantity: 2 }
}

const videoCapability: CapabilityMedia = {
  available: true,
  reason: null,
  action: null,
  modes: [{ id: 'text-to-video', referenceMaterial: { total: { min: 0, max: 1 } } }],
  durations: [5, 10],
  defaults: { duration: 5 }
}

const manifest: CapabilityManifest = {
  schemaVersion: 1,
  manifestVersion: 5,
  image: imageCapability,
  video: videoCapability
}

test('published rules follow manifest presence, not a media split', () => {
  assert.deepEqual(
    publishedParameterRules(imageCapability).map((rule) => rule.id),
    ['ratio', 'quantity']
  )
  assert.deepEqual(
    publishedParameterRules(videoCapability).map((rule) => rule.id),
    ['durationSeconds']
  )
  assert.deepEqual(publishedParameterRules({ available: true, reason: null, action: null }), [])
})

test('stale verdicts: unset tolerance and candidate membership per field', () => {
  const base = {
    mediaType: 'image',
    model: 'doubao-seedream-5.0-pro',
    mode: 'text-to-image',
    resolution: '2K',
    references: []
  } as const
  assert.equal(
    staleDraftFields(manifest, { ...base, ratio: null, quantity: 2 }).has('ratio'),
    false
  )
  assert.equal(
    staleDraftFields(manifest, { ...base, ratio: '9:21', quantity: 2 }).has('ratio'),
    true
  )
  assert.equal(
    staleDraftFields(manifest, { ...base, ratio: null, quantity: null }).has('quantity'),
    true
  )
  assert.equal(
    staleDraftFields(manifest, { ...base, ratio: null, quantity: 3 }).has('quantity'),
    true
  )

  const videoBase = {
    mediaType: 'video',
    model: null,
    mode: 'text-to-video',
    resolution: null,
    references: []
  } as const
  assert.equal(
    staleDraftFields(manifest, { ...videoBase, durationSeconds: 5 }).has('durationSeconds'),
    false
  )
  assert.equal(
    staleDraftFields(manifest, { ...videoBase, durationSeconds: null }).has('durationSeconds'),
    true
  )
  assert.equal(
    staleDraftFields(manifest, { ...videoBase, durationSeconds: 7 }).has('durationSeconds'),
    true
  )

  const bareManifest: CapabilityManifest = {
    schemaVersion: 1,
    manifestVersion: 5,
    image: { available: true, reason: null, action: null },
    video: videoCapability
  }
  const bareVerdicts = staleDraftFields(bareManifest, {
    ...base,
    ratio: '4:3',
    quantity: null
  })
  assert.equal(bareVerdicts.has('ratio'), false)
  assert.equal(bareVerdicts.has('quantity'), false)
})

test('manifest defaults adopt per the inventory, nulling when unpublished', () => {
  assert.deepEqual(manifestDefaultParameters(imageCapability), {
    ratio: '4:3',
    quantity: 2,
    durationSeconds: null
  })
  assert.deepEqual(manifestDefaultParameters(videoCapability), {
    ratio: null,
    quantity: null,
    durationSeconds: 5
  })
  assert.deepEqual(manifestDefaultParameters(null), {
    ratio: null,
    quantity: null,
    durationSeconds: null
  })
})

function fakeStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() {
      return entries.size
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, value)
  } as Storage
}

test('a stored record older than a parameter field survives the reload', () => {
  const storage = fakeStorage()
  storage.setItem(
    'nevix:creation:draft:user-1:aaaaaaaa-0000-4000-8000-000000000001',
    JSON.stringify({ prompt: '夏季跑鞋主图', manifest_version: 5, references: [] })
  )
  const oldest = readLocalDraft(storage, 'user-1', 'aaaaaaaa-0000-4000-8000-000000000001')
  assert.notEqual(oldest, null)
  assert.deepEqual(oldest?.mediaType, null)
  assert.deepEqual(oldest?.quantity, null)

  // A pre-video record: only duration_seconds absent.
  storage.setItem(
    'nevix:creation:draft:user-1:new',
    JSON.stringify({
      prompt: '未提交的新创作',
      prompt_document: { version: 1, nodes: [{ type: 'text', text: '未提交的新创作' }] },
      media_type: 'image',
      manifest_version: 5,
      model: 'doubao-seedream-5.0-pro',
      mode: 'reference-image',
      ratio: '4:3',
      resolution: '2K',
      quantity: 2,
      references: []
    })
  )
  const preVideo = readLocalDraft(storage, 'user-1', 'new')
  assert.notEqual(preVideo, null)
  assert.deepEqual(preVideo?.durationSeconds, null)
  assert.deepEqual(preVideo?.ratio, '4:3')
})

test('every inventory wire key is unique and snake_case', () => {
  const keys = Object.values(GENERATION_PARAMETER_WIRE_KEYS)
  assert.equal(new Set(keys).size, keys.length)
  for (const key of keys) {
    assert.match(key, /^[a-z][a-z0-9_]*$/)
  }
})
