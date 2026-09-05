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

const { RESULT_BLOB_CACHE_MAX_BYTES, ResultBlobCache } =
  await import('../../src/renderer/src/features/creation/lib/result-blob-cache.ts')

interface UrlLog {
  readonly created: string[]
  readonly revoked: string[]
}

function fakeUrls(): UrlLog & Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> {
  const created: string[] = []
  const revoked: string[] = []
  return {
    created,
    revoked,
    createObjectURL: () => {
      const url = `blob:${created.length + 1}`
      created.push(url)
      return url
    },
    revokeObjectURL: (url) => revoked.push(url)
  }
}

test('repeated display requests for one slot ride a single transfer', async () => {
  const loads: Array<{ taskId: string; slotIndex: number }> = []
  const urls = fakeUrls()
  const cache = new ResultBlobCache(
    async (taskId, slotIndex) => {
      loads.push({ taskId, slotIndex })
      return new Blob(['bytes'])
    },
    { urls }
  )

  const first = await cache.acquireObjectUrl('task-1', 0)
  const second = await cache.acquireObjectUrl('task-1', 0)
  assert.equal(first?.url, 'blob:1')
  assert.equal(second?.url, 'blob:1')
  assert.deepEqual(loads, [{ taskId: 'task-1', slotIndex: 0 }])
  assert.deepEqual(urls.created, ['blob:1'])
  first?.release()
  second?.release()
})

test('concurrent display requests share one in-flight transfer', async () => {
  const loads: number[] = []
  let release: ((blob: Blob) => void) | null = null
  const urls = fakeUrls()
  const cache = new ResultBlobCache(
    () =>
      new Promise((resolve) => {
        loads.push(loads.length + 1)
        release = (blob) => resolve(blob)
      }),
    { urls }
  )

  const first = cache.acquireObjectUrl('task-1', 0)
  const second = cache.acquireObjectUrl('task-1', 0)
  release?.(new Blob(['bytes']))

  const firstLease = await first
  const secondLease = await second
  assert.equal(firstLease?.url, 'blob:1')
  assert.equal(secondLease?.url, 'blob:1')
  assert.equal(loads.length, 1)
  firstLease?.release()
  secondLease?.release()
})

test('bytes and display consumers share one transfer', async () => {
  const bytes = new Blob(['bytes'])
  const loads: number[] = []
  const urls = fakeUrls()
  const cache = new ResultBlobCache(
    async () => {
      loads.push(loads.length + 1)
      return bytes
    },
    { urls }
  )

  assert.equal(await cache.blob('task-1', 0), bytes)
  const lease = await cache.acquireObjectUrl('task-1', 0)
  assert.equal(lease?.url, 'blob:1')
  assert.equal(loads.length, 1)
  lease?.release()
})

test('a failed transfer is not sticky — the next request retries the wire', async () => {
  const loads: number[] = []
  let failNext = true
  const urls = fakeUrls()
  const cache = new ResultBlobCache(
    async () => {
      loads.push(loads.length + 1)
      if (failNext) {
        failNext = false
        throw new Error('data plane unreachable')
      }
      return new Blob(['bytes'])
    },
    { urls }
  )

  assert.equal(await cache.acquireObjectUrl('task-1', 0), null)
  const lease = await cache.acquireObjectUrl('task-1', 0)
  assert.equal(lease?.url, 'blob:1')
  assert.equal(loads.length, 2)
  lease?.release()
})

test('dispose revokes every URL and later requests transfer again', async () => {
  const loads: number[] = []
  const urls = fakeUrls()
  const cache = new ResultBlobCache(
    async () => {
      loads.push(loads.length + 1)
      return new Blob(['bytes'])
    },
    { urls }
  )

  const first = await cache.acquireObjectUrl('task-1', 0)
  const second = await cache.acquireObjectUrl('task-2', 1)
  assert.equal(first?.url, 'blob:1')
  assert.equal(second?.url, 'blob:2')
  first?.release()
  second?.release()

  cache.dispose()
  assert.deepEqual(urls.revoked, ['blob:1', 'blob:2'])

  const reloaded = await cache.acquireObjectUrl('task-1', 0)
  assert.equal(reloaded?.url, 'blob:3')
  assert.equal(loads.length, 3)
  reloaded?.release()
})

test('a failed transfer landing after dispose does not evict its successor', async () => {
  const pending: Array<(blob: Blob | null) => void> = []
  const urls = fakeUrls()
  const cache = new ResultBlobCache(
    () => new Promise<Blob | null>((resolve) => pending.push(resolve)),
    { urls }
  )

  const stale = cache.acquireObjectUrl('task-1', 0)
  cache.dispose()
  const fresh = cache.acquireObjectUrl('task-1', 0)

  pending[0]?.(null)
  pending[1]?.(new Blob(['bytes']))

  assert.equal(await stale, null)
  const freshLease = await fresh
  assert.equal(freshLease?.url, 'blob:1')
  freshLease?.release()
})

test('the byte budget evicts the least-recently-used released result', async () => {
  const loads: string[] = []
  const urls = fakeUrls()
  const cache = new ResultBlobCache(
    async (taskId) => {
      loads.push(taskId)
      return new Blob(['1234'])
    },
    { maxBytes: 6, urls }
  )

  const first = await cache.acquireObjectUrl('task-1', 0)
  assert.ok(first)
  first.release()
  const second = await cache.acquireObjectUrl('task-2', 0)
  assert.ok(second)

  assert.deepEqual(urls.revoked, ['blob:1'])
  second.release()
  const firstAgain = await cache.acquireObjectUrl('task-1', 0)
  assert.ok(firstAgain)
  assert.deepEqual(loads, ['task-1', 'task-2', 'task-1'])
  firstAgain.release()
})

test('the default budget retains 64 MiB and evicts the next released result', async () => {
  const urls = fakeUrls()
  const fourMiB = new Uint8Array(4 * 1024 * 1024)
  const cache = new ResultBlobCache(async () => new Blob([fourMiB]), { urls })

  assert.equal(RESULT_BLOB_CACHE_MAX_BYTES, 64 * 1024 * 1024)
  for (let index = 0; index < 17; index += 1) {
    const lease = await cache.acquireObjectUrl(`task-${index}`, 0)
    assert.ok(lease)
    lease.release()
  }

  assert.deepEqual(urls.revoked, ['blob:1'])
})

test('budget eviction never revokes a URL while a consumer holds its lease', async () => {
  const urls = fakeUrls()
  const cache = new ResultBlobCache(async () => new Blob(['1234']), {
    maxBytes: 4,
    urls
  })

  const held = await cache.acquireObjectUrl('task-1', 0)
  const overflow = await cache.acquireObjectUrl('task-2', 0)
  assert.ok(held)
  assert.ok(overflow)
  overflow.release()

  assert.deepEqual(urls.revoked, ['blob:2'])
  assert.equal(held.url, 'blob:1')
  held.release()
})

test('an oversized byte consumer still receives its blob before the entry is evicted', async () => {
  const loads: number[] = []
  const cache = new ResultBlobCache(
    async () => {
      loads.push(loads.length + 1)
      return new Blob(['oversized'])
    },
    { maxBytes: 4, urls: fakeUrls() }
  )

  assert.equal((await cache.blob('task-1', 0))?.size, 9)
  assert.equal((await cache.blob('task-1', 0))?.size, 9)
  assert.equal(loads.length, 2)
})

test('dispose invalidates an in-flight lease without creating a late URL', async () => {
  let release: ((blob: Blob) => void) | null = null
  const urls = fakeUrls()
  const cache = new ResultBlobCache(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
    { maxBytes: 4, urls }
  )

  const pending = cache.acquireObjectUrl('task-1', 0)
  cache.dispose()
  release?.(new Blob(['1234']))

  assert.equal(await pending, null)
  assert.deepEqual(urls.created, [])
})
