import type { AssetPrivateOrigin } from '../api/asset-library-http'
import { GENERATION_PARAMETERS } from '../api/generation-parameter'
import { readWorkbenchDraft, writeLocalDraft } from './draft-store'
import { textPromptDocument } from './prompt-document'

export type AssetSimilarDraftResult = 'prepared' | 'replacement-required' | 'unavailable'

export function prepareAssetSimilarDraft(
  storage: Storage,
  userId: string,
  origin: AssetPrivateOrigin,
  replaceExisting = false
): AssetSimilarDraftResult {
  const specification = origin.specification
  const current = readWorkbenchDraft(storage, userId, 'new')?.drafts[specification.mediaType]
  if (
    !replaceExisting &&
    current !== undefined &&
    (current.prompt.trim() !== '' ||
      current.promptDocument.nodes.some((node) => node.type === 'mention') ||
      current.references.length > 0 ||
      GENERATION_PARAMETERS.some(({ id }) => id !== 'mediaType' && current[id] !== null))
  ) {
    return 'replacement-required'
  }
  const persisted = writeLocalDraft(storage, userId, 'new', {
    prompt: specification.prompt,
    promptDocument: textPromptDocument(specification.prompt),
    mediaType: specification.mediaType,
    model: specification.model,
    mode: specification.mode,
    manifestVersion: specification.manifestVersion,
    ratio: specification.ratio,
    resolution: specification.resolution,
    quantity: specification.quantity,
    durationSeconds: specification.durationSeconds,
    references: []
  })
  return persisted ? 'prepared' : 'unavailable'
}
