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
  loadMaterialBlob: WorkbenchDisplayDeps['loadMaterialBlob'] = async () => networkFailure(),
  loadResultBlob: WorkbenchDisplayDeps['loadResultBlob'] = async () => networkFailure()
): WorkbenchDisplayController {
  const controller = new WorkbenchDisplayController({ loadMaterialBlob, loadResultBlob, urls })
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

test('an in-flight thumbnail load cannot land after reset()', async () => {
  const urls = fakeUrls()
  const load = deferred<CreationApiResult<Blob>>()
  const controller = createController(urls, () => load.promise)
  controller.replaceMaterials([materialView('m1')])
  const release = controller.retain('m1')
  assert.equal(controller.getSnapshot().thumbnailStates.m1, 'loading')

  controller.reset()
  release()
  load.resolve({ outcome: 'succeeded', value: new Blob(['bytes']) })
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

test('thumbnail leases refcount: the last release retires the entry', async () => {
  const urls = fakeUrls()
  const blob = new Blob(['thumb'])
  const controller = createController(urls, async () => ({ outcome: 'succeeded', value: blob }))
  controller.replaceMaterials([materialView('m1')])
  const releaseFirst = controller.retain('m1')
  const releaseSecond = controller.retain('m1')
  await flush()
  await flush()

  assert.equal(controller.getSnapshot().thumbnailStates.m1, 'ready')
  assert.ok(controller.getSnapshot().thumbnails.m1 !== undefined)

  releaseFirst()
  assert.ok(controller.getSnapshot().thumbnails.m1 !== undefined)

  releaseSecond()
  assert.equal(controller.getSnapshot().thumbnails.m1, undefined)
  assert.equal(controller.getSnapshot().thumbnailStates.m1, undefined)
})

test('forget() releases a server-backed material thumbnail URL and tolerates the late release', async () => {
  const urls = fakeUrls()
  const blob = new Blob(['thumb'])
  const controller = createController(urls, async () => ({ outcome: 'succeeded', value: blob }))
  controller.replaceMaterials([materialView('m1')])
  const release = controller.retain('m1')
  await flush()
  await flush()
  const url = controller.getSnapshot().thumbnails.m1
  assert.ok(url !== undefined)

  controller.forget('m1')

  assert.equal(controller.getSnapshot().materials.length, 0)
  assert.ok(urls.revoked.includes(url))
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
  const blobLoads: string[] = []
  const controller = createController(urls, async (materialId) => {
    blobLoads.push(materialId)
    return { outcome: 'succeeded', value: new Blob(['thumb']) }
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
  assert.deepEqual(blobLoads, [])
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
