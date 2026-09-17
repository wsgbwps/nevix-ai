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

const { writePublicationSimilarDraft } =
  await import('../../src/renderer/src/features/creation/model/publication-similar-draft.ts')
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

const result = {
  session: {
    id: 'server-session',
    name: 'Publication reuse',
    createdAt: '2026-09-17T08:00:00Z',
    updatedAt: '2026-09-17T08:00:00Z'
  },
  materials: [],
  specification: {
    schemaVersion: 1,
    mediaType: 'image' as const,
    prompt: 'Preserve the stale values',
    model: 'removed-model',
    mode: 'reference-image',
    manifestVersion: 2,
    ratio: 'deprecated-ratio',
    resolution: 'old-resolution',
    quantity: 2,
    durationSeconds: null,
    references: [
      {
        materialId: 'remapped-material',
        role: 'reference' as const,
        kind: 'image' as const,
        claimsVersion: 3
      }
    ]
  },
  submissionBlocked: true
}

test('Publication reuse writes the server intent under its durable Session identity', () => {
  const local = storage()
  assert.equal(writePublicationSimilarDraft(local, 'user-one', result), true)
  assert.equal(readLocalDraft(local, 'user-one', 'new'), null)
  assert.deepEqual(readLocalDraft(local, 'user-one', 'server-session'), {
    prompt: 'Preserve the stale values',
    promptDocument: { version: 1, nodes: [{ type: 'text', text: 'Preserve the stale values' }] },
    mediaType: 'image',
    model: 'removed-model',
    mode: 'reference-image',
    manifestVersion: 2,
    ratio: 'deprecated-ratio',
    resolution: 'old-resolution',
    quantity: 2,
    durationSeconds: null,
    references: [{ materialId: 'remapped-material', role: 'reference' }]
  })
})

test('Publication reuse reports a local persistence failure without changing identity', () => {
  const local = storage()
  local.setItem = () => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError')
  }
  assert.equal(writePublicationSimilarDraft(local, 'user-one', result), false)
  assert.equal(readLocalDraft(local, 'user-one', 'server-session'), null)
})
