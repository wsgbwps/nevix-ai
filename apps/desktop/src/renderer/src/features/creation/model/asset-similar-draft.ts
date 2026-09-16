import type { AssetPrivateOrigin } from '../api/asset-library-http'
import { readLocalDraft, writeLocalDraft } from './draft-store'
import { textPromptDocument } from './prompt-document'

export type AssetSimilarDraftResult = 'prepared' | 'replacement-required' | 'unavailable'

export function prepareAssetSimilarDraft(
  storage: Storage,
  userId: string,
  origin: AssetPrivateOrigin,
  replaceExisting = false
): AssetSimilarDraftResult {
  if (!replaceExisting && readLocalDraft(storage, userId, 'new') !== null) {
    return 'replacement-required'
  }
  const specification = origin.specification
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
