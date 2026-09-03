import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import type { ReferenceMaterialView } from '../../src/renderer/src/features/creation/api/go-creation-http.ts'

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
  countPromptMentions,
  decodePromptDocument,
  expandPromptDocument,
  filterPromptMentionCandidates,
  normalizePromptDocument,
  parsePromptDocument,
  promptDocumentLength,
  prunePromptMentions,
  promptMentionCandidates,
  remapPromptMentions,
  removePromptMentions,
  textPromptDocument
} = await import('../../src/renderer/src/features/creation/model/prompt-document.ts')

const englishKindLabels = { image: 'Image', video: 'Video', audio: 'Audio' } as const
const chineseKindLabels = { image: '图片', video: '视频', audio: '音频' } as const

function material(
  id: string,
  kind: 'image' | 'video' | 'audio',
  fileName: string
): ReferenceMaterialView {
  return {
    id,
    kind,
    fileName,
    mimeType: `${kind}/test`,
    byteSize: 1,
    widthPx: null,
    heightPx: null,
    pixelCount: null,
    durationMs: null,
    checksumSha256: 'checksum',
    claimsVersion: 1,
    createdAt: '2026-09-03T00:00:00Z'
  }
}

test('a legacy string becomes one plain-text document node', () => {
  assert.deepEqual(textPromptDocument('@图片 1 stays ordinary text'), {
    version: 1,
    nodes: [{ type: 'text', text: '@图片 1 stays ordinary text' }]
  })
})

test('an invalid structured document falls back to unverifiable text without guessing mentions', () => {
  assert.equal(
    decodePromptDocument({ version: 1, nodes: [{ type: 'mention', materialId: '' }] }),
    null
  )
  assert.deepEqual(
    parsePromptDocument(
      { version: 1, nodes: [{ type: 'mention', label: 'Image 1' }] },
      'keep manual @Image 1'
    ),
    {
      version: 1,
      nodes: [{ type: 'text', text: 'keep manual @Image 1' }]
    }
  )
})

test('normalization coalesces adjacent text without disturbing mention identity', () => {
  assert.deepEqual(
    normalizePromptDocument({
      version: 1,
      nodes: [
        { type: 'text', text: '前' },
        { type: 'text', text: '' },
        { type: 'text', text: '景' },
        { type: 'mention', materialId: 'image-a' },
        { type: 'text', text: '' },
        { type: 'text', text: '之后' }
      ]
    }),
    {
      version: 1,
      nodes: [
        { type: 'text', text: '前景' },
        { type: 'mention', materialId: 'image-a' },
        { type: 'text', text: '之后' }
      ]
    }
  )
})

test('a valid structured document parses into the canonical linear form', () => {
  assert.deepEqual(
    parsePromptDocument(
      {
        version: 1,
        nodes: [
          { type: 'text', text: 'use ' },
          { type: 'text', text: 'this ' },
          { type: 'mention', materialId: 'image-a', label: 'must not persist' }
        ]
      },
      'fallback'
    ),
    {
      version: 1,
      nodes: [
        { type: 'text', text: 'use this ' },
        { type: 'mention', materialId: 'image-a' }
      ]
    }
  )
})

test('mention candidates follow reference order and number each material kind independently', () => {
  const imageA = material('image-a', 'image', 'hero.png')
  const videoB = material('video-b', 'video', 'motion.mp4')
  const imageC = material('image-c', 'image', 'detail.png')
  const audioD = material('audio-d', 'audio', 'music.wav')
  const references = [imageA, videoB, imageC, audioD].map(({ id }) => ({
    materialId: id,
    role: 'reference' as const
  }))

  assert.deepEqual(
    promptMentionCandidates(references, [audioD, imageC, imageA, videoB], chineseKindLabels),
    [
      { materialId: 'image-a', kind: 'image', ordinal: 1, label: '图片 1', fileName: 'hero.png' },
      {
        materialId: 'video-b',
        kind: 'video',
        ordinal: 1,
        label: '视频 1',
        fileName: 'motion.mp4'
      },
      {
        materialId: 'image-c',
        kind: 'image',
        ordinal: 2,
        label: '图片 2',
        fileName: 'detail.png'
      },
      {
        materialId: 'audio-d',
        kind: 'audio',
        ordinal: 1,
        label: '音频 1',
        fileName: 'music.wav'
      }
    ]
  )
})

test('candidate filtering is an ordered case-insensitive substring match on ordinal, label, or filename', () => {
  const imageA = {
    materialId: 'image-a',
    kind: 'image' as const,
    ordinal: 1,
    label: 'Image 1',
    fileName: 'Hero.PNG'
  }
  const videoB = {
    materialId: 'video-b',
    kind: 'video' as const,
    ordinal: 1,
    label: 'Video 1',
    fileName: 'Motion.MP4'
  }
  const imageC = {
    materialId: 'image-c',
    kind: 'image' as const,
    ordinal: 2,
    label: 'Image 2',
    fileName: 'Detail.PNG'
  }
  const candidates = [imageA, videoB, imageC]

  assert.deepEqual(filterPromptMentionCandidates('image', candidates), [imageA, imageC])
  assert.deepEqual(filterPromptMentionCandidates('2', candidates), [imageC])
  assert.deepEqual(filterPromptMentionCandidates('hErO.p', candidates), [imageA])
})

test('expansion preserves manual @ text and repeats the current localized mention label', () => {
  const imageA = material('image-a', 'image', 'hero.png')
  const videoB = material('video-b', 'video', 'motion.mp4')
  const candidates = promptMentionCandidates(
    [imageA, videoB].map(({ id }) => ({ materialId: id, role: 'reference' as const })),
    [imageA, videoB],
    englishKindLabels
  )
  const document = {
    version: 1 as const,
    nodes: [
      { type: 'text' as const, text: 'manual @Image 1 + ' },
      { type: 'mention' as const, materialId: 'image-a' },
      { type: 'text' as const, text: ' then ' },
      { type: 'mention' as const, materialId: 'image-a' },
      { type: 'text' as const, text: ' with ' },
      { type: 'mention' as const, materialId: 'video-b' }
    ]
  }

  assert.equal(
    expandPromptDocument(document, candidates),
    'manual @Image 1 + Image 1 then Image 1 with Video 1'
  )
})

test('pruning removes stale identities and retains normalized surrounding text', () => {
  const document = {
    version: 1 as const,
    nodes: [
      { type: 'text' as const, text: 'keep ' },
      { type: 'mention' as const, materialId: 'image-a' },
      { type: 'text' as const, text: ' before ' },
      { type: 'mention' as const, materialId: 'stale-b' },
      { type: 'text' as const, text: ' after' }
    ]
  }

  assert.deepEqual(prunePromptMentions(document, [{ materialId: 'image-a', role: 'reference' }]), {
    version: 1,
    nodes: [
      { type: 'text', text: 'keep ' },
      { type: 'mention', materialId: 'image-a' },
      { type: 'text', text: ' before  after' }
    ]
  })
})

test('pending-id remapping updates every occurrence while leaving failed uploads retryable', () => {
  const document = {
    version: 1 as const,
    nodes: [
      { type: 'mention' as const, materialId: 'pending-a' },
      { type: 'text' as const, text: ' / ' },
      { type: 'mention' as const, materialId: 'pending-b' },
      { type: 'text' as const, text: ' / ' },
      { type: 'mention' as const, materialId: 'pending-a' }
    ]
  }

  assert.deepEqual(remapPromptMentions(document, new Map([['pending-a', 'real-a']])), {
    version: 1,
    nodes: [
      { type: 'mention', materialId: 'real-a' },
      { type: 'text', text: ' / ' },
      { type: 'mention', materialId: 'pending-b' },
      { type: 'text', text: ' / ' },
      { type: 'mention', materialId: 'real-a' }
    ]
  })
})

test('mention count reports every occurrence bound to one material', () => {
  const document = {
    version: 1 as const,
    nodes: [
      { type: 'mention' as const, materialId: 'image-a' },
      { type: 'mention' as const, materialId: 'image-b' },
      { type: 'mention' as const, materialId: 'image-a' }
    ]
  }

  assert.equal(countPromptMentions(document, 'image-a'), 2)
})

test('removing a material deletes all bound occurrences but leaves other mentions intact', () => {
  const document = {
    version: 1 as const,
    nodes: [
      { type: 'text' as const, text: 'first ' },
      { type: 'mention' as const, materialId: 'image-a' },
      { type: 'text' as const, text: ' / ' },
      { type: 'mention' as const, materialId: 'image-b' },
      { type: 'text' as const, text: ' / ' },
      { type: 'mention' as const, materialId: 'image-a' },
      { type: 'text' as const, text: ' last' }
    ]
  }

  assert.deepEqual(removePromptMentions(document, 'image-a'), {
    version: 1,
    nodes: [
      { type: 'text', text: 'first  / ' },
      { type: 'mention', materialId: 'image-b' },
      { type: 'text', text: ' /  last' }
    ]
  })
})

test('prompt length counts Unicode code points in the final localized expansion', () => {
  const document = {
    version: 1 as const,
    nodes: [
      { type: 'text' as const, text: 'A😀' },
      { type: 'mention' as const, materialId: 'image-a' }
    ]
  }
  const candidates = [
    {
      materialId: 'image-a',
      kind: 'image' as const,
      ordinal: 1,
      label: '图片 1',
      fileName: 'hero.png'
    }
  ]

  assert.equal(promptDocumentLength(document, candidates), 6)
})
