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

const { listReferenceMaterialUploadRecoveries, putReferenceMaterialUploadRecovery } =
  await import('../../src/renderer/src/features/creation/model/reference-material-upload-recovery.ts')
const { listReferenceMaterialDeleteRecoveries, putReferenceMaterialDeleteRecovery } =
  await import('../../src/renderer/src/features/creation/model/reference-material-delete-recovery.ts')

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

test('upload recovery serializes only restart-safe facts in the user/server namespace', () => {
  const storage = fakeStorage()
  putReferenceMaterialUploadRecovery(storage, 'user-1', 'https://server.example', {
    uploadId: '00000000-0000-4000-8000-000000000001',
    idempotencyKey: '00000000-0000-4000-8000-000000000002',
    sessionId: '00000000-0000-4000-8000-000000000003',
    fileName: 'photo.png',
    declaredKind: 'image',
    declaredMimeType: 'image/png',
    declaredByteSize: 3,
    putExpiresAt: '2026-09-09T09:00:00Z',
    finalizeExpiresAt: '2026-09-09T09:30:00Z',
    localPath: '/private/tmp/private.png',
    objectKey: 'reference-materials/private',
    signedUrl: 'https://signed.example/private',
    credential: 'secret',
    rawResponse: 'provider-secret',
    content: 'png'
  } as never)

  const serialized = storage.getItem(storage.key(0) ?? '') ?? ''
  for (const forbidden of [
    '/private/tmp',
    'reference-materials/',
    'signed.example',
    'secret',
    'provider-secret',
    'content'
  ]) {
    assert.equal(serialized.includes(forbidden), false, `serialized recovery leaked ${forbidden}`)
  }
  assert.deepEqual(
    listReferenceMaterialUploadRecoveries(storage, 'user-1', 'https://server.example'),
    [
      {
        uploadId: '00000000-0000-4000-8000-000000000001',
        idempotencyKey: '00000000-0000-4000-8000-000000000002',
        sessionId: '00000000-0000-4000-8000-000000000003',
        fileName: 'photo.png',
        declaredKind: 'image',
        declaredMimeType: 'image/png',
        declaredByteSize: 3,
        putExpiresAt: '2026-09-09T09:00:00Z',
        finalizeExpiresAt: '2026-09-09T09:30:00Z'
      }
    ]
  )
  assert.deepEqual(
    listReferenceMaterialUploadRecoveries(storage, 'user-2', 'https://server.example'),
    []
  )
  assert.deepEqual(
    listReferenceMaterialUploadRecoveries(storage, 'user-1', 'https://other.example'),
    []
  )
})

test('a provisional recovery may omit server-issued facts but not declared facts', () => {
  const storage = fakeStorage()
  putReferenceMaterialUploadRecovery(storage, 'user-1', 'https://server.example', {
    idempotencyKey: 'local-id',
    sessionId: 'session-id',
    fileName: 'photo.png',
    declaredKind: 'image',
    declaredMimeType: 'image/png',
    declaredByteSize: 3
  })
  assert.deepEqual(
    listReferenceMaterialUploadRecoveries(storage, 'user-1', 'https://server.example'),
    [
      {
        idempotencyKey: 'local-id',
        sessionId: 'session-id',
        fileName: 'photo.png',
        declaredKind: 'image',
        declaredMimeType: 'image/png',
        declaredByteSize: 3
      }
    ]
  )
})

test('material delete recovery persists only scoped server identities', () => {
  const storage = fakeStorage()
  putReferenceMaterialDeleteRecovery(storage, 'user-1', 'https://server.example', {
    sessionId: '00000000-0000-4000-8000-000000000003',
    materialId: '00000000-0000-4000-8000-000000000004',
    objectKey: 'reference-materials/private',
    signedUrl: 'https://signed.example/private',
    credential: 'secret'
  } as never)

  const serialized = storage.getItem(storage.key(0) ?? '') ?? ''
  assert.equal(serialized.includes('reference-materials/'), false)
  assert.equal(serialized.includes('signed.example'), false)
  assert.equal(serialized.includes('secret'), false)
  assert.deepEqual(
    listReferenceMaterialDeleteRecoveries(storage, 'user-1', 'https://server.example'),
    [
      {
        sessionId: '00000000-0000-4000-8000-000000000003',
        materialId: '00000000-0000-4000-8000-000000000004'
      }
    ]
  )
  assert.deepEqual(
    listReferenceMaterialDeleteRecoveries(storage, 'user-2', 'https://server.example'),
    []
  )
})

test('material delete recovery drops non-UUID path traversal facts instead of replaying them', () => {
  const storage = fakeStorage()
  storage.setItem(
    'nevix:creation:reference-material-delete:user-1:https%3A%2F%2Fserver.example:corrupt',
    JSON.stringify({
      sessionId: '00000000-0000-4000-8000-000000000003',
      materialId: '../sessions/00000000-0000-4000-8000-000000000004'
    })
  )

  assert.deepEqual(
    listReferenceMaterialDeleteRecoveries(storage, 'user-1', 'https://server.example'),
    []
  )
  assert.equal(storage.length, 0)
})
