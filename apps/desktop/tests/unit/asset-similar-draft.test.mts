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

const { prepareAssetSimilarDraft } =
  await import('../../src/renderer/src/features/creation/model/asset-similar-draft.ts')
const { readLocalDraft } =
  await import('../../src/renderer/src/features/creation/model/draft-store.ts')

function storage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value)
  } as Storage
}

const origin = {
  sessionId: 'private-session',
  sessionName: 'Launch',
  taskId: 'private-task',
  slotIndex: 2,
  specification: {
    mediaType: 'image' as const,
    prompt: 'Replacement prompt',
    model: 'seedream',
    mode: 'text-to-image',
    manifestVersion: 4,
    ratio: '1:1',
    resolution: '2K',
    quantity: 1,
    durationSeconds: null
  }
}

test('create similar writes only the safe generation intent into the new local draft', () => {
  const local = storage()
  assert.equal(
    prepareAssetSimilarDraft(local, 'user-one', {
      sessionId: 'private-session',
      sessionName: 'Launch',
      taskId: 'private-task',
      slotIndex: 2,
      specification: {
        mediaType: 'image',
        prompt: 'A quiet launch scene',
        model: 'seedream',
        mode: 'reference-image',
        manifestVersion: 4,
        ratio: '3:2',
        resolution: '2K',
        quantity: 2,
        durationSeconds: null
      }
    }),
    'prepared'
  )

  const draft = readLocalDraft(local, 'user-one', 'new')
  assert.deepEqual(draft, {
    prompt: 'A quiet launch scene',
    promptDocument: { version: 1, nodes: [{ type: 'text', text: 'A quiet launch scene' }] },
    mediaType: 'image',
    model: 'seedream',
    mode: 'reference-image',
    manifestVersion: 4,
    ratio: '3:2',
    resolution: '2K',
    quantity: 2,
    durationSeconds: null,
    references: []
  })
  assert.equal(JSON.stringify(draft).includes('private-task'), false)
  assert.equal(JSON.stringify(draft).includes('private-session'), false)
})

test('create similar requires an explicit replacement before overwriting a new draft', () => {
  const local = storage()

  prepareAssetSimilarDraft(local, 'user-one', {
    ...origin,
    specification: { ...origin.specification, prompt: 'Existing prompt' }
  })

  assert.equal(prepareAssetSimilarDraft(local, 'user-one', origin), 'replacement-required')
  assert.equal(readLocalDraft(local, 'user-one', 'new')?.prompt, 'Existing prompt')
  assert.equal(prepareAssetSimilarDraft(local, 'user-one', origin, true), 'prepared')
  assert.equal(readLocalDraft(local, 'user-one', 'new')?.prompt, 'Replacement prompt')
})

test('create similar is unavailable when the local draft cannot be persisted', () => {
  const local = storage()
  local.setItem = () => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError')
  }

  assert.equal(prepareAssetSimilarDraft(local, 'user-one', origin), 'unavailable')
  assert.equal(readLocalDraft(local, 'user-one', 'new'), null)
})
