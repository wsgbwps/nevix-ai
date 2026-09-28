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
const { readLocalDraft, readWorkbenchDraft, writeLocalDraft } =
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
        durationSeconds: null,
        references: [
          { materialId: 'source-material', role: 'reference', kind: 'image', claimsVersion: 1 }
        ]
      },
      references: [
        {
          id: 'source-material',
          role: 'reference',
          kind: 'image',
          fileName: 'source.png',
          mimeType: 'image/png',
          byteSize: 10,
          widthPx: 1,
          heightPx: 1,
          durationMs: null,
          claimsVersion: 1
        }
      ]
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

test('create similar replaces only its image draft without confirming video content', () => {
  const local = storage()
  const video = {
    prompt: 'Keep video',
    promptDocument: { version: 1 as const, nodes: [{ type: 'text' as const, text: 'Keep video' }] },
    mediaType: 'video' as const,
    model: 'seedance',
    mode: 'text-to-video',
    manifestVersion: 5,
    ratio: null,
    resolution: '720p',
    quantity: 1,
    durationSeconds: 5,
    references: [{ materialId: 'video-material', role: 'omni' as const }]
  }
  assert.equal(writeLocalDraft(local, 'user-one', 'new', video), true)

  assert.equal(prepareAssetSimilarDraft(local, 'user-one', origin), 'prepared')
  assert.deepEqual(readWorkbenchDraft(local, 'user-one', 'new'), {
    activeMediaType: 'image',
    drafts: {
      image: readLocalDraft(local, 'user-one', 'new'),
      video
    }
  })
  assert.equal(readLocalDraft(local, 'user-one', 'new')?.prompt, 'Replacement prompt')
})

test('create similar confirms before replacing target parameters without a prompt', () => {
  const local = storage()
  assert.equal(
    writeLocalDraft(local, 'user-one', 'new', {
      prompt: '',
      promptDocument: { version: 1, nodes: [{ type: 'text', text: '' }] },
      mediaType: 'image',
      model: 'chosen-model',
      mode: 'text-to-image',
      manifestVersion: 5,
      ratio: '16:9',
      resolution: '2K',
      quantity: 1,
      durationSeconds: null,
      references: []
    }),
    true
  )
  assert.equal(prepareAssetSimilarDraft(local, 'user-one', origin), 'replacement-required')
})

test('video similar preserves an existing image draft and activates video', () => {
  const local = storage()
  const image = {
    prompt: 'Keep image',
    promptDocument: { version: 1 as const, nodes: [{ type: 'text' as const, text: 'Keep image' }] },
    mediaType: 'image' as const,
    model: 'seedream',
    mode: 'text-to-image',
    manifestVersion: 4,
    ratio: '1:1',
    resolution: '2K',
    quantity: 1,
    durationSeconds: null,
    references: []
  }
  assert.equal(writeLocalDraft(local, 'user-one', 'new', image), true)
  assert.equal(
    prepareAssetSimilarDraft(local, 'user-one', {
      ...origin,
      specification: {
        ...origin.specification,
        mediaType: 'video',
        prompt: 'Video source',
        model: 'seedance',
        mode: 'text-to-video',
        ratio: null,
        resolution: '720p',
        durationSeconds: 5
      }
    }),
    'prepared'
  )
  const workbench = readWorkbenchDraft(local, 'user-one', 'new')
  assert.equal(workbench?.activeMediaType, 'video')
  assert.deepEqual(workbench?.drafts.image, image)
  assert.equal(workbench?.drafts.video.prompt, 'Video source')
})

test('create similar is unavailable when the local draft cannot be persisted', () => {
  const local = storage()
  local.setItem = () => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError')
  }

  assert.equal(prepareAssetSimilarDraft(local, 'user-one', origin), 'unavailable')
  assert.equal(readLocalDraft(local, 'user-one', 'new'), null)
})
