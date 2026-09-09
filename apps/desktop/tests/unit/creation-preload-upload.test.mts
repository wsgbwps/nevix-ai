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

const { createCreationUploadBridge } = await import('../../src/preload/creation-upload.ts')

test('the preload bridge resolves a real File path and never returns it to the renderer', async () => {
  const invoked: unknown[] = []
  const bridge = createCreationUploadBridge({
    getPathForFile: () => '/private/tmp/photo.png',
    invokeUpload: async (request) => {
      invoked.push(request)
      return { outcome: 'network-failure' }
    },
    invokeCancel: async () => undefined,
    onProgress: () => () => undefined
  })
  const file = new File(['png'], 'photo.png', { type: 'image/png' })

  const result = await bridge.uploadReferenceMaterial('operation-1', 'session-1', file)

  assert.deepEqual(invoked, [
    {
      operationId: 'operation-1',
      sessionId: 'session-1',
      localPath: '/private/tmp/photo.png',
      fileName: 'photo.png',
      declaredKind: 'image',
      declaredMimeType: 'image/png',
      declaredByteSize: 3
    }
  ])
  assert.deepEqual(result, { outcome: 'network-failure' })
  assert.equal(JSON.stringify(result).includes('/private/tmp'), false)
})

test('a programmatic File without a native path is rejected before private IPC', async () => {
  let invoked = false
  const bridge = createCreationUploadBridge({
    getPathForFile: () => '',
    invokeUpload: async () => {
      invoked = true
      return { outcome: 'network-failure' }
    },
    invokeCancel: async () => undefined,
    onProgress: () => () => undefined
  })

  const result = await bridge.uploadReferenceMaterial(
    'operation-1',
    'session-1',
    new File(['png'], 'photo.png', { type: 'image/png' })
  )

  assert.deepEqual(result, { outcome: 'request-rejected', code: 'invalid_local_file' })
  assert.equal(invoked, false)
})

test('a non-File value is rejected before path resolution or private IPC', async () => {
  let pathResolved = false
  let invoked = false
  const bridge = createCreationUploadBridge({
    getPathForFile: () => {
      pathResolved = true
      return '/private/tmp/photo.png'
    },
    invokeUpload: async () => {
      invoked = true
      return { outcome: 'network-failure' }
    },
    invokeCancel: async () => undefined,
    onProgress: () => () => undefined
  })

  const result = await bridge.uploadReferenceMaterial('operation-1', 'session-1', {} as File)

  assert.deepEqual(result, { outcome: 'request-rejected', code: 'invalid_local_file' })
  assert.equal(pathResolved, false)
  assert.equal(invoked, false)
})

test('a path-resolution error becomes a stable rejection without private IPC', async () => {
  let invoked = false
  const bridge = createCreationUploadBridge({
    getPathForFile: () => {
      throw new Error('unavailable path')
    },
    invokeUpload: async () => {
      invoked = true
      return { outcome: 'network-failure' }
    },
    invokeCancel: async () => undefined,
    onProgress: () => () => undefined
  })

  const result = await bridge.uploadReferenceMaterial(
    'operation-1',
    'session-1',
    new File(['png'], 'photo.png', { type: 'image/png' })
  )

  assert.deepEqual(result, { outcome: 'request-rejected', code: 'invalid_local_file' })
  assert.equal(invoked, false)
})

test('the bridge filters progress and exposes primitive operation cancellation', async () => {
  let listener:
    | ((progress: { operationId: string; sentBytes: number; totalBytes: number }) => void)
    | null = null
  const cancellations: string[] = []
  const progress: number[] = []
  const pending = Promise.withResolvers<{ readonly outcome: 'network-failure' }>()
  const bridge = createCreationUploadBridge({
    getPathForFile: () => '/private/tmp/photo.png',
    invokeUpload: async () => pending.promise,
    invokeCancel: async (operationId) => void cancellations.push(operationId),
    onProgress: (next) => {
      listener = next
      return () => {
        listener = null
      }
    }
  })
  const completion = bridge.uploadReferenceMaterial(
    'operation-1',
    'session-1',
    new File(['png'], 'photo.png', { type: 'image/png' }),
    (value) => progress.push(value.sentBytes)
  )

  listener?.({ operationId: 'other', sentBytes: 1, totalBytes: 3 })
  listener?.({ operationId: 'operation-1', sentBytes: 2, totalBytes: 3 })
  await bridge.cancelReferenceMaterialUpload('operation-1')
  pending.resolve({ outcome: 'network-failure' })
  await completion

  assert.deepEqual(progress, [2])
  assert.deepEqual(cancellations, ['operation-1'])
  assert.equal(listener, null)
})
