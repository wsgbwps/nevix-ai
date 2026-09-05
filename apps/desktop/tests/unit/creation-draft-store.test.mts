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

const {
  readLocalDraft,
  writeLocalDraft,
  removeLocalDraft,
  setLocalDraftOperationNotice,
  listPendingLocalDraftKeys,
  moveLocalDraft
} = await import('../../src/renderer/src/features/creation/model/draft-store.ts')

/** Minimal in-memory Storage stand-in; production passes window.localStorage. */
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

const record = {
  prompt: '夏季跑鞋主图，暖光背景',
  promptDocument: {
    version: 1 as const,
    nodes: [
      { type: 'text' as const, text: '参考 ' },
      { type: 'mention' as const, materialId: 'cccccccc-0000-4000-8000-000000000003' }
    ]
  },
  mediaType: 'image' as const,
  model: 'doubao-seedream-5.0-pro',
  mode: 'reference-image',
  ratio: '4:3',
  resolution: '2K',
  quantity: 2,
  durationSeconds: null,
  references: [
    { materialId: 'cccccccc-0000-4000-8000-000000000003', role: 'reference' as const },
    { materialId: 'dddddddd-0000-4000-8000-000000000004', role: 'reference' as const }
  ],
  manifestVersion: 5
}

test('a written draft round-trips verbatim under its session key', () => {
  const storage = fakeStorage()
  writeLocalDraft(storage, 'user-1', 'aaaaaaaa-0000-4000-8000-000000000001', record)
  assert.deepEqual(
    readLocalDraft(storage, 'user-1', 'aaaaaaaa-0000-4000-8000-000000000001'),
    record
  )
})

test('the composing draft lives under the "new" key and survives like any session', () => {
  const storage = fakeStorage()
  writeLocalDraft(storage, 'user-1', 'new', { ...record, prompt: '未提交的新创作' })
  assert.equal(readLocalDraft(storage, 'user-1', 'new')?.prompt, '未提交的新创作')
})

test('draft keys are account-scoped: another user reads nothing', () => {
  const storage = fakeStorage()
  writeLocalDraft(storage, 'user-1', 'aaaaaaaa-0000-4000-8000-000000000001', record)
  assert.equal(readLocalDraft(storage, 'user-2', 'aaaaaaaa-0000-4000-8000-000000000001'), null)
  // The stored key itself carries the user id, so a same-key write cannot
  // leak across accounts.
  const keys = Object.keys((storage as unknown as { key(i: number): string | null }) && {})
  void keys
  assert.notEqual(
    storage.getItem('nevix:creation:draft:user-1:aaaaaaaa-0000-4000-8000-000000000001'),
    null
  )
  assert.equal(
    storage.getItem('nevix:creation:draft:user-2:aaaaaaaa-0000-4000-8000-000000000001'),
    null
  )
})

test('removal clears exactly one draft', () => {
  const storage = fakeStorage()
  writeLocalDraft(storage, 'user-1', 'aaaaaaaa-0000-4000-8000-000000000001', record)
  writeLocalDraft(storage, 'user-1', 'new', record)
  removeLocalDraft(storage, 'user-1', 'aaaaaaaa-0000-4000-8000-000000000001')
  assert.equal(readLocalDraft(storage, 'user-1', 'aaaaaaaa-0000-4000-8000-000000000001'), null)
  assert.notEqual(readLocalDraft(storage, 'user-1', 'new'), null)
})

test('corrupted or foreign payloads fail closed to null', () => {
  const storage = fakeStorage()
  const key = 'nevix:creation:draft:user-1:aaaaaaaa-0000-4000-8000-000000000001'
  storage.setItem(key, '{not json')
  assert.equal(readLocalDraft(storage, 'user-1', 'aaaaaaaa-0000-4000-8000-000000000001'), null)

  storage.setItem(key, JSON.stringify({ prompt: 'shape from another feature' }))
  assert.equal(readLocalDraft(storage, 'user-1', 'aaaaaaaa-0000-4000-8000-000000000001'), null)

  // A reference entry with an unknown role rejects the whole record.
  storage.setItem(
    key,
    JSON.stringify({ ...record, references: [{ materialId: 'x', role: 'hero' }] })
  )
  assert.equal(readLocalDraft(storage, 'user-1', 'aaaaaaaa-0000-4000-8000-000000000001'), null)
})

test('a pre-mention draft migrates its fallback prompt without inferring identity', () => {
  const storage = fakeStorage()
  const key = 'nevix:creation:draft:user-1:aaaaaaaa-0000-4000-8000-000000000001'
  storage.setItem(
    key,
    JSON.stringify({
      prompt: record.prompt,
      media_type: record.mediaType,
      manifest_version: record.manifestVersion,
      model: record.model,
      mode: record.mode,
      ratio: record.ratio,
      resolution: record.resolution,
      quantity: record.quantity,
      duration_seconds: record.durationSeconds,
      references: record.references.map((reference) => ({
        material_id: reference.materialId,
        role: reference.role
      }))
    })
  )

  assert.deepEqual(
    readLocalDraft(storage, 'user-1', 'aaaaaaaa-0000-4000-8000-000000000001')?.promptDocument,
    { version: 1, nodes: [{ type: 'text', text: '夏季跑鞋主图，暖光背景' }] }
  )
})

test('an invalid prompt document preserves the valid fallback and the rest of the draft', () => {
  const storage = fakeStorage()
  writeLocalDraft(storage, 'user-1', 'new', record)
  const key = 'nevix:creation:draft:user-1:new'
  const stored = JSON.parse(storage.getItem(key) ?? '{}')
  stored.prompt_document = {
    version: 1,
    nodes: [{ type: 'mention', label: '图片 1' }]
  }
  storage.setItem(key, JSON.stringify(stored))

  const restored = readLocalDraft(storage, 'user-1', 'new')
  assert.equal(restored?.model, record.model)
  assert.deepEqual(restored?.promptDocument, {
    version: 1,
    nodes: [{ type: 'text', text: record.prompt }]
  })
})

test('only the minimum unresolved-operation notice persists beside the editable draft', () => {
  const storage = fakeStorage()
  const key = 'aaaaaaaa-0000-4000-8000-000000000001'
  writeLocalDraft(storage, 'user-1', key, record)

  setLocalDraftOperationNotice(storage, 'user-1', key, {
    sessionUnconfirmed: false,
    submissionUnconfirmed: true,
    materialFileNames: ['shoe.png', 'detail.png']
  })
  assert.deepEqual(readLocalDraft(storage, 'user-1', key)?.operationNotice, {
    sessionUnconfirmed: false,
    submissionUnconfirmed: true,
    materialFileNames: ['shoe.png', 'detail.png']
  })
  const stored = storage.getItem(`nevix:creation:draft:user-1:${key}`) ?? ''
  assert.equal(stored.includes('idempotency'), false)
  assert.equal(stored.includes('File'), false)

  setLocalDraftOperationNotice(storage, 'user-1', key, null)
  assert.equal(readLocalDraft(storage, 'user-1', key)?.operationNotice, undefined)
})

test('a pre-#193 notice without a session marker still parses as session-confirmed', () => {
  const storage = fakeStorage()
  const key = 'aaaaaaaa-0000-4000-8000-000000000001'
  writeLocalDraft(storage, 'user-1', key, record)
  // The literal wire shape a #192 build persisted.
  storage.setItem(
    `nevix:creation:draft:user-1:${key}`,
    JSON.stringify({
      prompt: record.prompt,
      prompt_document: record.promptDocument,
      media_type: 'image',
      manifest_version: 5,
      model: record.model,
      mode: 'text-to-image',
      ratio: '1:1',
      resolution: '2K',
      quantity: 1,
      duration_seconds: null,
      references: [],
      operation_notice: {
        kind: 'unconfirmed-writes',
        submission_unconfirmed: true,
        material_file_names: ['shoe.png']
      }
    })
  )
  assert.deepEqual(readLocalDraft(storage, 'user-1', key)?.operationNotice, {
    sessionUnconfirmed: false,
    submissionUnconfirmed: true,
    materialFileNames: ['shoe.png']
  })
})

test('a session-unconfirmed notice alone keeps the record flagged', () => {
  const storage = fakeStorage()
  const key = 'pending:11111111-1111-4111-8111-111111111111'
  writeLocalDraft(storage, 'user-1', key, record)
  setLocalDraftOperationNotice(storage, 'user-1', key, {
    sessionUnconfirmed: true,
    submissionUnconfirmed: false,
    materialFileNames: []
  })
  assert.deepEqual(readLocalDraft(storage, 'user-1', key)?.operationNotice, {
    sessionUnconfirmed: true,
    submissionUnconfirmed: false,
    materialFileNames: []
  })
})

test('pending keys list from storage and move preserves the record exactly once', () => {
  const storage = fakeStorage()
  const pendingKey = 'pending:11111111-1111-4111-8111-111111111111'
  const otherUserKey = 'pending:33333333-3333-4333-8333-333333333333'
  const sessionId = 'eeeeeeee-0000-4000-8000-000000000007'
  writeLocalDraft(storage, 'user-1', pendingKey, record)
  writeLocalDraft(storage, 'other-user', otherUserKey, record)
  writeLocalDraft(storage, 'user-1', sessionId, record)
  // A corrupted pending payload must not surface as a recoverable entry.
  storage.setItem('nevix:creation:draft:user-1:pending:44444444-4444-4444-8444-444444444444', '{')

  assert.deepEqual(listPendingLocalDraftKeys(storage, 'user-1'), [pendingKey])

  moveLocalDraft(storage, 'user-1', pendingKey, 'eeeeeeee-0000-4000-8000-000000000008')
  assert.equal(readLocalDraft(storage, 'user-1', pendingKey), null)
  assert.equal(
    readLocalDraft(storage, 'user-1', 'eeeeeeee-0000-4000-8000-000000000008')?.prompt,
    record.prompt
  )
  assert.deepEqual(listPendingLocalDraftKeys(storage, 'user-1'), [])
  assert.deepEqual(listPendingLocalDraftKeys(storage, 'other-user'), [otherUserKey])

  // Moving a missing record is a no-op, never a destructive write.
  moveLocalDraft(storage, 'user-1', pendingKey, sessionId)
  assert.equal(readLocalDraft(storage, 'user-1', sessionId)?.prompt, record.prompt)
})
