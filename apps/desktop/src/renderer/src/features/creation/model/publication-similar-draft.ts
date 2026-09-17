import type { PublicationSimilarResult } from '../api/inspiration-http'
import { writeLocalDraft } from './draft-store'
import { textPromptDocument } from './prompt-document'

export function writePublicationSimilarDraft(
  storage: Storage,
  userId: string,
  result: PublicationSimilarResult
): boolean {
  const specification = result.specification
  return writeLocalDraft(storage, userId, result.session.id, {
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
    references: specification.references.map(({ materialId, role }) => ({ materialId, role }))
  })
}
