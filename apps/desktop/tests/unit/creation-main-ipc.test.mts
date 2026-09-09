import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

function moduleSource(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('window/trusted-renderer-sender')) {
      return {
        url: moduleSource(
          `export const requireTrustedTopLevelRendererSender = (event) => globalThis.__nevixTrustSender(event)`
        ),
        shortCircuit: true
      }
    }
    if (specifier.endsWith('electron-reference-material-upload')) {
      return {
        url: moduleSource(`export const electronReferenceMaterialUploadDependencies = {}`),
        shortCircuit: true
      }
    }
    if (/\/reference-material-upload$/.test(specifier)) {
      return {
        url: moduleSource(
          `export const runReferenceMaterialUpload = (...args) => globalThis.__nevixRunUpload(...args)
           export const recoverReferenceMaterialUpload = (...args) => globalThis.__nevixRecoverUpload(...args)
           export const abortReferenceMaterialUploadRecovery = (...args) => globalThis.__nevixAbortUpload(...args)`
        ),
        shortCircuit: true
      }
    }
    if (specifier.endsWith('active-reference-material-uploads')) {
      return {
        url: moduleSource(`
          export const beginReferenceMaterialUpload = (id) => globalThis.__nevixBeginUpload(id)
          export const endReferenceMaterialUpload = (id) => globalThis.__nevixEndUpload(id)
          export const cancelReferenceMaterialUpload = (id) => globalThis.__nevixCancelUpload(id)
        `),
        shortCircuit: true
      }
    }
    const isDesktopSource = context.parentURL?.includes('/apps/desktop/src/') === true
    const resolvedSpecifier =
      isDesktopSource && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)
        ? `${specifier}.ts`
        : specifier
    return nextResolve(resolvedSpecifier, context)
  }
})

interface HandlerGlobals {
  __nevixTrustSender?: (event: unknown) => void
  __nevixBeginUpload?: (id: string) => AbortController | null
  __nevixEndUpload?: (id: string) => void
  __nevixCancelUpload?: (id: string) => void
  __nevixRunUpload?: (...args: unknown[]) => Promise<{ outcome: 'network-failure' }>
  __nevixRecoverUpload?: (...args: unknown[]) => Promise<{ outcome: 'network-failure' }>
  __nevixAbortUpload?: (...args: unknown[]) => Promise<{ outcome: 'network-failure' }>
}

const globals = globalThis as typeof globalThis & HandlerGlobals
const { uploadReferenceMaterialHandler } =
  await import('../../src/main/creation/ipc/upload-reference-material.ts')
const { cancelReferenceMaterialUploadHandler } =
  await import('../../src/main/creation/ipc/cancel-reference-material-upload.ts')
const { recoverReferenceMaterialUploadHandler } =
  await import('../../src/main/creation/ipc/recover-reference-material-upload.ts')
const { abortReferenceMaterialUploadHandler } =
  await import('../../src/main/creation/ipc/abort-reference-material-upload.ts')

const event = {
  sender: {
    isDestroyed: () => false,
    send: () => undefined
  }
} as unknown as Electron.IpcMainInvokeEvent

const request = {
  operationId: 'operation-1',
  idempotencyKey: 'local-material-1',
  sessionId: '00000000-0000-4000-8000-000000000010',
  localPath: '/private/tmp/photo.png',
  fileName: 'photo.png',
  declaredKind: 'image',
  declaredMimeType: 'image/png',
  declaredByteSize: 3
}

test('upload and cancel handlers reject an untrusted renderer before side effects', async () => {
  let sideEffects = 0
  globals.__nevixTrustSender = () => {
    throw new Error('untrusted')
  }
  globals.__nevixBeginUpload = () => {
    sideEffects++
    return new AbortController()
  }
  globals.__nevixCancelUpload = () => {
    sideEffects++
  }

  await assert.rejects(() => uploadReferenceMaterialHandler(event, request), /untrusted/)
  assert.throws(
    () => cancelReferenceMaterialUploadHandler(event, { operationId: 'operation-1' }),
    /untrusted/
  )
  assert.equal(sideEffects, 0)
})

test('upload handler accepts only an absolute path and always retires its operation', async () => {
  const lifecycle: string[] = []
  globals.__nevixTrustSender = () => undefined
  globals.__nevixBeginUpload = (id) => {
    lifecycle.push(`begin:${id}`)
    return new AbortController()
  }
  globals.__nevixEndUpload = (id) => lifecycle.push(`end:${id}`)
  globals.__nevixRunUpload = async () => {
    lifecycle.push('run')
    return { outcome: 'network-failure' }
  }

  assert.deepEqual(await uploadReferenceMaterialHandler(event, request), {
    outcome: 'network-failure'
  })
  assert.deepEqual(lifecycle, ['begin:operation-1', 'run', 'end:operation-1'])

  await assert.rejects(
    () => uploadReferenceMaterialHandler(event, { ...request, localPath: 'relative.png' }),
    /invalid request/
  )
  await assert.rejects(
    () => uploadReferenceMaterialHandler(event, { ...request, sessionId: '../sessions/victim' }),
    /invalid request/
  )
  assert.deepEqual(lifecycle, ['begin:operation-1', 'run', 'end:operation-1'])
})

test('cancel handler validates a primitive operation identity', () => {
  const cancelled: string[] = []
  globals.__nevixTrustSender = () => undefined
  globals.__nevixCancelUpload = (id) => void cancelled.push(id)

  cancelReferenceMaterialUploadHandler(event, { operationId: 'operation-2' })
  assert.deepEqual(cancelled, ['operation-2'])
  assert.throws(
    () => cancelReferenceMaterialUploadHandler(event, { operationId: '', extra: true }),
    /invalid request/
  )
})

test('recovery handler accepts only the closed restart-safe fact set', async () => {
  const lifecycle: string[] = []
  globals.__nevixTrustSender = () => undefined
  globals.__nevixBeginUpload = (id) => {
    lifecycle.push(`begin:${id}`)
    return new AbortController()
  }
  globals.__nevixEndUpload = (id) => lifecycle.push(`end:${id}`)
  globals.__nevixRecoverUpload = async (...args) => {
    assert.equal(args[2] instanceof AbortSignal, true)
    lifecycle.push('recover')
    return { outcome: 'network-failure' }
  }
  const recovery = {
    uploadId: '00000000-0000-4000-8000-000000000020',
    idempotencyKey: 'local-material-1',
    sessionId: '00000000-0000-4000-8000-000000000010',
    fileName: 'photo.png',
    declaredKind: 'image',
    declaredMimeType: 'image/png',
    declaredByteSize: 3,
    putExpiresAt: '2026-09-09T09:00:00Z',
    finalizeExpiresAt: '2026-09-09T09:30:00Z'
  }

  assert.deepEqual(
    await recoverReferenceMaterialUploadHandler(event, {
      operationId: 'recovery-operation-1',
      recovery
    }),
    {
      outcome: 'network-failure'
    }
  )
  assert.deepEqual(lifecycle, ['begin:recovery-operation-1', 'recover', 'end:recovery-operation-1'])
  await assert.rejects(
    () =>
      recoverReferenceMaterialUploadHandler(event, {
        operationId: 'recovery-operation-2',
        recovery: { ...recovery, localPath: '/private/tmp/x' }
      }),
    /invalid facts/
  )
  await assert.rejects(
    () =>
      recoverReferenceMaterialUploadHandler(event, {
        operationId: 'recovery-operation-3',
        recovery: { ...recovery, uploadId: '../../creation/sessions/victim' }
      }),
    /invalid facts/
  )
})

test('durable abort handler shares validation and owns a cancellable operation', async () => {
  const lifecycle: string[] = []
  globals.__nevixTrustSender = () => undefined
  globals.__nevixBeginUpload = (id) => {
    lifecycle.push(`begin:${id}`)
    return new AbortController()
  }
  globals.__nevixEndUpload = (id) => lifecycle.push(`end:${id}`)
  globals.__nevixAbortUpload = async (...args) => {
    assert.equal(args[2] instanceof AbortSignal, true)
    lifecycle.push('abort')
    return { outcome: 'network-failure' }
  }
  const recovery = {
    uploadId: '00000000-0000-4000-8000-000000000020',
    idempotencyKey: 'local-material-1',
    sessionId: '00000000-0000-4000-8000-000000000010',
    fileName: 'photo.png',
    declaredKind: 'image',
    declaredMimeType: 'image/png',
    declaredByteSize: 3,
    putExpiresAt: '2026-09-09T09:00:00Z',
    finalizeExpiresAt: '2026-09-09T09:30:00Z'
  }

  assert.deepEqual(
    await abortReferenceMaterialUploadHandler(event, {
      operationId: 'abort-operation-1',
      recovery
    }),
    { outcome: 'network-failure' }
  )
  assert.deepEqual(lifecycle, ['begin:abort-operation-1', 'abort', 'end:abort-operation-1'])
})
