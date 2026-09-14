import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
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

const { WorkbenchDisplayController } =
  await import('../../src/renderer/src/features/creation/model/workbench-display-controller.ts')
import type { WorkbenchDisplayDeps } from '../../src/renderer/src/features/creation/model/workbench-display-controller.ts'
import type {
  CreationApiResult,
  MaterialUrlView,
  ReferenceMaterialView
} from '../../src/renderer/src/features/creation/api/go-creation-http.ts'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function fakeUrls(): Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> & {
  revoked: string[]
} {
  let sequence = 0
  const revoked: string[] = []
  return {
    revoked,
    createObjectURL: (): string => `blob:mock-${(sequence += 1)}`,
    revokeObjectURL: (url: string): void => {
      revoked.push(url)
    }
  }
}

function materialView(id: string): ReferenceMaterialView {
  return {
    id,
    kind: 'image',
    fileName: `${id}.png`,
    mimeType: 'image/png',
    byteSize: 1,
    widthPx: null,
    heightPx: null,
    pixelCount: null,
    durationMs: null,
    checksumSha256: '',
    claimsVersion: 0,
    createdAt: '1970-01-01T00:00:00.000Z'
  }
}

function imageFile(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
}

const networkFailure = (): CreationApiResult<Blob> => ({ outcome: 'network-failure' })
const thumbnailUrlFailure = (): CreationApiResult<MaterialUrlView> => ({
  outcome: 'network-failure'
})

/** A grant far enough ahead to stay live for the test's lifetime. */
const liveGrant = (url: string): MaterialUrlView => ({
  url,
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString()
})

// loadImageDimensions instantiates the DOM Image; pending image files
// always probe dimensions, so every test runs against this deterministic
// stub instead.
class StubImage {
  naturalWidth = 64
  naturalHeight = 48
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  #src = ''
  set src(value: string) {
    this.#src = value
    queueMicrotask(() => this.onload?.())
  }
  get src(): string {
    return this.#src
  }
}

const originalImage = (globalThis as { Image?: unknown }).Image
before(() => {
  ;(globalThis as { Image?: unknown }).Image = StubImage
})
after(() => {
  ;(globalThis as { Image?: unknown }).Image = originalImage
})

function createController(
  urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>,
  loadThumbnailUrl: WorkbenchDisplayDeps['loadThumbnailUrl'] = async () => thumbnailUrlFailure(),
  loadResultBlob: WorkbenchDisplayDeps['loadResultBlob'] = async () => networkFailure(),
  loadPreviewUrl: WorkbenchDisplayDeps['loadPreviewUrl'] = async () => thumbnailUrlFailure()
): WorkbenchDisplayController {
  const controller = new WorkbenchDisplayController({
    loadPreviewUrl,
    loadThumbnailUrl,
    loadResultBlob,
    urls
  })
  controller.activate()
  return controller
}

test('reset() clears snapshots and pending files in the same tick, revoking preview URLs', () => {
  const urls = fakeUrls()
  const controller = createController(urls)
  controller.registerPending('p1', imageFile('a.png'))
  const preview = controller.getSnapshot().thumbnails.p1
  assert.ok(preview !== undefined)
  assert.equal(controller.getSnapshot().materials.length, 1)

  controller.reset()

  const snapshot = controller.getSnapshot()
  assert.deepEqual(snapshot.materials, [])
  assert.deepEqual(snapshot.thumbnails, {})
  assert.deepEqual(snapshot.thumbnailStates, {})
  assert.ok(urls.revoked.includes(preview))
})

test('getSnapshot() is same-tick fresh after mutations and notifies subscribers', () => {
  const urls = fakeUrls()
  const controller = createController(urls)
  let notifications = 0
  controller.subscribe(() => {
    notifications += 1
  })

  controller.replaceMaterials([materialView('m1'), materialView('m2')])

  assert.equal(controller.getSnapshot().materials.length, 2)
  assert.ok(notifications >= 1)
})

test('dropping a pending upload clears progress in the same tick without a thumbnail', () => {
  const controller = createController(fakeUrls())
  controller.registerPending(
    'pending-audio',
    new File([new Uint8Array([1, 2, 3])], 'voice.mp3', { type: 'audio/mpeg' })
  )
  controller.updateUploadProgress('pending-audio', 1, 3)

  controller.dropPending('pending-audio')

  assert.deepEqual(controller.getSnapshot().uploadProgress, {})
})

test('an in-flight thumbnail load cannot land after reset()', async () => {
  const urls = fakeUrls()
  const load = deferred<CreationApiResult<MaterialUrlView>>()
  const controller = createController(urls, () => load.promise)
  controller.replaceMaterials([materialView('m1')])
  const release = controller.retain('m1')
  assert.equal(controller.getSnapshot().thumbnailStates.m1, 'loading')

  controller.reset()
  release()
  load.resolve({ outcome: 'succeeded', value: liveGrant('https://thumb.example/m1') })
  await flush()
  await flush()

  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.thumbnailStates.m1, undefined)
  assert.equal(snapshot.thumbnails.m1, undefined)
  assert.deepEqual(snapshot.materials, [])
})

test('a late release from a retired generation leaves the new one untouched', () => {
  const urls = fakeUrls()
  const controller = createController(urls)
  const release = controller.retain('m1')

  controller.reset()
  controller.registerPending('m1', imageFile('fresh.png'))

  release()
  assert.ok(controller.getSnapshot().thumbnails.m1 !== undefined)
  assert.equal(controller.getSnapshot().materials.length, 1)
})

test('thumbnail leases refcount: releases keep a remote URL entry painting', async () => {
  const urls = fakeUrls()
  const controller = createController(urls, async () => ({
    outcome: 'succeeded',
    value: liveGrant('https://thumb.example/m1')
  }))
  controller.replaceMaterials([materialView('m1')])
  const releaseFirst = controller.retain('m1')
  const releaseSecond = controller.retain('m1')
  await flush()
  await flush()

  assert.equal(controller.getSnapshot().thumbnailStates.m1, 'ready')
  assert.ok(controller.getSnapshot().thumbnails.m1 !== undefined)

  releaseFirst()
  assert.ok(controller.getSnapshot().thumbnails.m1 !== undefined)

  // A remote entry is one string until its TTL: dropping it at zero
  // consumers would re-authorize on every scroll-through.
  releaseSecond()
  assert.ok(controller.getSnapshot().thumbnails.m1 !== undefined)
  assert.deepEqual(urls.revoked, [])
})

test('the last release still retires a local preview object URL', () => {
  const urls = fakeUrls()
  const controller = createController(urls)
  controller.registerPending('pending-1', imageFile('a.png'))
  const release = controller.retain('pending-1')
  const preview = controller.getSnapshot().thumbnails['pending-1']
  assert.ok(preview !== undefined)

  release()

  assert.equal(controller.getSnapshot().thumbnails['pending-1'], undefined)
  assert.ok(urls.revoked.includes(preview))
})

test('an expired remote thumbnail re-authorizes on the next request', async () => {
  const urls = fakeUrls()
  const stale: MaterialUrlView = {
    url: 'https://thumb.example/m1?sig=stale',
    expiresAt: new Date(Date.now() - 60_000).toISOString()
  }
  const fresh = deferred<CreationApiResult<MaterialUrlView>>()
  const loads: string[] = []
  const controller = createController(urls, (materialId) => {
    loads.push(materialId)
    return loads.length === 1
      ? Promise.resolve({ outcome: 'succeeded', value: stale })
      : fresh.promise
  })
  controller.replaceMaterials([materialView('m1')])

  const firstRelease = controller.retain('m1')
  await flush()
  await flush()
  assert.equal(controller.getSnapshot().thumbnails.m1, 'https://thumb.example/m1?sig=stale')
  firstRelease()

  // The stale grant is past its TTL: a new consumer re-authorizes, and while
  // that is in flight the stale URL stops painting instead of awaiting a
  // bucket 403.
  const secondRelease = controller.retain('m1')
  await flush()
  assert.equal(controller.getSnapshot().thumbnails.m1, undefined)
  assert.equal(controller.getSnapshot().thumbnailStates.m1, 'loading')

  fresh.resolve({ outcome: 'succeeded', value: liveGrant('https://thumb.example/m1?sig=fresh') })
  await flush()
  await flush()
  assert.equal(controller.getSnapshot().thumbnails.m1, 'https://thumb.example/m1?sig=fresh')
  assert.deepEqual(loads, ['m1', 'm1'])
  secondRelease()
})

test('a failed thumbnail authorization paints the failed state and retries on a later retain', async () => {
  const urls = fakeUrls()
  let failures = 0
  const controller = createController(urls, () => {
    if (failures === 0) {
      failures += 1
      return Promise.resolve({ outcome: 'network-failure' })
    }
    return Promise.resolve({
      outcome: 'succeeded',
      value: liveGrant('https://thumb.example/m1')
    })
  })
  controller.replaceMaterials([materialView('m1')])

  const firstRelease = controller.retain('m1')
  await flush()
  await flush()
  assert.equal(controller.getSnapshot().thumbnailStates.m1, 'failed')
  assert.equal(controller.getSnapshot().thumbnails.m1, undefined)

  firstRelease()
  const secondRelease = controller.retain('m1')
  await flush()
  await flush()
  assert.equal(controller.getSnapshot().thumbnailStates.m1, 'ready')
  assert.equal(controller.getSnapshot().thumbnails.m1, 'https://thumb.example/m1')
  secondRelease()
})

test('forget() drops a remote thumbnail entry and tolerates the late release', async () => {
  const urls = fakeUrls()
  const controller = createController(urls, async () => ({
    outcome: 'succeeded',
    value: liveGrant('https://thumb.example/m1')
  }))
  controller.replaceMaterials([materialView('m1')])
  const release = controller.retain('m1')
  await flush()
  await flush()
  assert.ok(controller.getSnapshot().thumbnails.m1 !== undefined)

  controller.forget('m1')

  assert.equal(controller.getSnapshot().materials.length, 0)
  assert.equal(controller.getSnapshot().thumbnails.m1, undefined)
  release()
  assert.equal(controller.getSnapshot().thumbnails.m1, undefined)
})

test('replaceMaterials and registerPending merge, with dimension backfill', async () => {
  const urls = fakeUrls()
  const controller = createController(urls)
  controller.replaceMaterials([materialView('server-1')])
  const pending = controller.registerPending('local-1', imageFile('local.png'))
  assert.equal(pending.kind, 'image')

  const merged = controller.getSnapshot().materials
  assert.equal(merged.length, 2)
  assert.equal(merged[1]?.id, 'local-1')

  await flush()
  await flush()
  const backfilled = controller.getSnapshot().materials.find((m) => m.id === 'local-1')
  assert.equal(backfilled?.widthPx, 64)
  assert.equal(backfilled?.heightPx, 48)
  assert.equal(backfilled?.pixelCount, 64 * 48)
})

test('acquireResultBlobUrl resolves null when the result read fails', async () => {
  const urls = fakeUrls()
  const controller = createController(urls)
  const lease = await controller.acquireResultBlobUrl('task-1', 0)
  assert.equal(lease, null)
})

test('transferPending re-keys the painted preview onto the server identity without a refetch', async () => {
  const urls = fakeUrls()
  const urlLoads: string[] = []
  const controller = createController(urls, async (materialId) => {
    urlLoads.push(materialId)
    return { outcome: 'succeeded', value: liveGrant(`https://thumb.example/${materialId}`) }
  })
  controller.registerPending('pending-1', imageFile('a.png'))
  const release = controller.retain('pending-1')
  const preview = controller.getSnapshot().thumbnails['pending-1']
  assert.ok(preview !== undefined)

  controller.transferPending('pending-1', 'server-1')

  // The card re-keys with its thumbnail already painted: same URL, no glyph
  // frame, no blob re-fetch — and its React key alias lets the deck keep the
  // mounted node across the swap.
  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.thumbnails['server-1'], preview)
  assert.equal(snapshot.thumbnails['pending-1'], undefined)
  assert.deepEqual(snapshot.cardKeyAliases, { 'server-1': 'pending-1' })
  assert.equal(controller.pendingFiles().has('pending-1'), false)

  // The deck's lease effect re-keys around the transfer; the stale lease's
  // release must not disturb the transferred entry, and a fresh lease must
  // not trigger a load.
  release()
  const releaseServer = controller.retain('server-1')
  await flush()
  await flush()
  assert.equal(controller.getSnapshot().thumbnails['server-1'], preview)
  assert.deepEqual(urlLoads, [])
  assert.ok(!urls.revoked.includes(preview))
  releaseServer()
})

test('reset clears the card key aliases with the rest of the generation', () => {
  const urls = fakeUrls()
  const controller = createController(urls)
  controller.registerPending('pending-1', imageFile('a.png'))
  controller.transferPending('pending-1', 'server-1')
  assert.deepEqual(controller.getSnapshot().cardKeyAliases, { 'server-1': 'pending-1' })

  controller.reset()

  assert.deepEqual(controller.getSnapshot().cardKeyAliases, {})
})

test('re-registering a live pending refreshes the file handle without rebuilding its preview URL', () => {
  const urls = fakeUrls()
  const controller = createController(urls)
  controller.registerPending('pending-1', imageFile('a.png'))
  const preview = controller.getSnapshot().thumbnails['pending-1']
  assert.ok(preview !== undefined)

  const view = controller.registerPending('pending-1', imageFile('a.png'))

  assert.equal(view.id, 'pending-1')
  assert.equal(controller.getSnapshot().thumbnails['pending-1'], preview)
  assert.equal(controller.getSnapshot().materials.length, 1)
  assert.deepEqual(urls.revoked, [])
})

test('transferPending stays same-tick fresh for a non-image pending', () => {
  const urls = fakeUrls()
  const controller = createController(urls)
  let notifications = 0
  controller.subscribe(() => {
    notifications += 1
  })
  controller.registerPending(
    'pending-1',
    new File([new Uint8Array([1])], 'a.mp4', { type: 'video/mp4' })
  )
  const before = notifications

  controller.transferPending('pending-1', 'server-1')

  assert.ok(notifications > before)
  assert.deepEqual(controller.getSnapshot().cardKeyAliases, { 'server-1': 'pending-1' })
  assert.equal(controller.pendingFiles().has('pending-1'), false)
})

test('a stored material previews from its presigned URL', async () => {
  const grant = liveGrant('https://preview.example/m1')
  const controller = createController(
    fakeUrls(),
    async () => thumbnailUrlFailure(),
    async () => networkFailure(),
    async () => ({ outcome: 'succeeded', value: grant })
  )
  controller.replaceMaterials([materialView('m1')])

  assert.deepEqual(await controller.loadMaterialPreviewSource('m1'), grant)
})

test('a pending material previews from its local file', async () => {
  const controller = createController(fakeUrls())
  const file = imageFile('a.png')
  controller.registerPending('pending-1', file)

  assert.equal(await controller.loadMaterialPreviewSource('pending-1'), file)
})

test('a failed preview authorization yields null', async () => {
  const controller = createController(fakeUrls())
  controller.replaceMaterials([materialView('m1')])

  assert.equal(await controller.loadMaterialPreviewSource('m1'), null)
})
