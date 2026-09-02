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

const { readLocalDraft, writeLocalDraft, removeLocalDraft } =
  await import('../../src/renderer/src/features/creation/model/draft-store.ts')

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
