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

const { ResultBlobCache } =
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
  const cache = new ResultBlobCache(async (taskId, slotIndex) => {
    loads.push({ taskId, slotIndex })
    return new Blob(['bytes'])
  }, urls)

  assert.equal(await cache.objectUrl('task-1', 0), 'blob:1')
  assert.equal(await cache.objectUrl('task-1', 0), 'blob:1')
  assert.deepEqual(loads, [{ taskId: 'task-1', slotIndex: 0 }])
  assert.deepEqual(urls.created, ['blob:1'])
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
    urls
  )

  const first = cache.objectUrl('task-1', 0)
  const second = cache.objectUrl('task-1', 0)
  release?.(new Blob(['bytes']))

  assert.equal(await first, 'blob:1')
  assert.equal(await second, 'blob:1')
  assert.equal(loads.length, 1)
})

test('bytes and display consumers share one transfer', async () => {
  const bytes = new Blob(['bytes'])
  const loads: number[] = []
  const urls = fakeUrls()
  const cache = new ResultBlobCache(async () => {
    loads.push(loads.length + 1)
    return bytes
  }, urls)

  assert.equal(await cache.blob('task-1', 0), bytes)
  assert.equal(await cache.objectUrl('task-1', 0), 'blob:1')
  assert.equal(loads.length, 1)
})

test('a failed transfer is not sticky — the next request retries the wire', async () => {
  const loads: number[] = []
  let failNext = true
  const urls = fakeUrls()
  const cache = new ResultBlobCache(async () => {
    loads.push(loads.length + 1)
    if (failNext) {
      failNext = false
      throw new Error('data plane unreachable')
    }
    return new Blob(['bytes'])
  }, urls)

  assert.equal(await cache.objectUrl('task-1', 0), null)
  assert.equal(await cache.objectUrl('task-1', 0), 'blob:1')
  assert.equal(loads.length, 2)
})

test('dispose revokes every URL and later requests transfer again', async () => {
  const loads: number[] = []
  const urls = fakeUrls()
  const cache = new ResultBlobCache(async () => {
    loads.push(loads.length + 1)
    return new Blob(['bytes'])
  }, urls)

  assert.equal(await cache.objectUrl('task-1', 0), 'blob:1')
  assert.equal(await cache.objectUrl('task-2', 1), 'blob:2')

  cache.dispose()
  assert.deepEqual(urls.revoked, ['blob:1', 'blob:2'])

  assert.equal(await cache.objectUrl('task-1', 0), 'blob:3')
  assert.equal(loads.length, 3)
})

test('a failed transfer landing after dispose does not evict its successor', async () => {
  const pending: Array<(blob: Blob | null) => void> = []
  const urls = fakeUrls()
  const cache = new ResultBlobCache(
    () => new Promise<Blob | null>((resolve) => pending.push(resolve)),
    urls
  )

  const stale = cache.objectUrl('task-1', 0)
  cache.dispose()
  const fresh = cache.objectUrl('task-1', 0)

  pending[0]?.(null)
  pending[1]?.(new Blob(['bytes']))

  assert.equal(await stale, null)
  assert.equal(await fresh, 'blob:1')
})
