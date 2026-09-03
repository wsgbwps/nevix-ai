import type { DraftReferenceView, ReferenceMaterialView } from '../api/go-creation-http'

export type PromptNode =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'mention'; readonly materialId: string }

export interface PromptDocument {
  readonly version: 1
  readonly nodes: readonly PromptNode[]
}

export interface PromptMentionCandidate {
  readonly materialId: string
  readonly kind: ReferenceMaterialView['kind']
  readonly ordinal: number
  readonly label: string
  readonly fileName: string
}

export type PromptMentionKindLabels = Readonly<Record<ReferenceMaterialView['kind'], string>>

export function textPromptDocument(text: string): PromptDocument {
  return { version: 1, nodes: [{ type: 'text', text }] }
}

export function normalizePromptDocument(document: PromptDocument): PromptDocument {
  const nodes: PromptNode[] = []
  for (const node of document.nodes) {
    const previous = nodes.at(-1)
    if (node.type === 'text' && previous?.type === 'text') {
      nodes[nodes.length - 1] = { type: 'text', text: previous.text + node.text }
    } else if (node.type === 'mention' || node.text.length > 0) {
      nodes.push({ ...node })
    }
  }
  return { version: 1, nodes }
}

export function promptMentionCandidates(
  references: readonly DraftReferenceView[],
  materials: readonly ReferenceMaterialView[],
  kindLabels: PromptMentionKindLabels
): PromptMentionCandidate[] {
  const materialsById = new Map(materials.map((material) => [material.id, material]))
  const ordinals: Record<ReferenceMaterialView['kind'], number> = {
    image: 0,
    video: 0,
    audio: 0
  }
  return references.flatMap((reference) => {
    const material = materialsById.get(reference.materialId)
    if (material === undefined) return []
    const ordinal = ++ordinals[material.kind]
    return [
      {
        materialId: material.id,
        kind: material.kind,
        ordinal,
        label: `${kindLabels[material.kind]} ${ordinal}`,
        fileName: material.fileName
      }
    ]
  })
}

export function filterPromptMentionCandidates(
  query: string,
  candidates: readonly PromptMentionCandidate[]
): PromptMentionCandidate[] {
  const needle = query.toLowerCase()
  return candidates.filter((candidate) =>
    [String(candidate.ordinal), candidate.label, candidate.fileName].some((value) =>
      value.toLowerCase().includes(needle)
    )
  )
}

export function expandPromptDocument(
  document: PromptDocument,
  candidates: readonly PromptMentionCandidate[]
): string {
  const labels = new Map(candidates.map((candidate) => [candidate.materialId, candidate.label]))
  return document.nodes
    .map((node) => (node.type === 'text' ? node.text : (labels.get(node.materialId) ?? '')))
    .join('')
}

export function promptDocumentLength(
  document: PromptDocument,
  candidates: readonly PromptMentionCandidate[]
): number {
  return [...expandPromptDocument(document, candidates)].length
}

export function prunePromptMentions(
  document: PromptDocument,
  references: readonly DraftReferenceView[]
): PromptDocument {
  const materialIds = new Set(references.map((reference) => reference.materialId))
  return normalizePromptDocument({
    version: 1,
    nodes: document.nodes.filter((node) => node.type === 'text' || materialIds.has(node.materialId))
  })
}

export function remapPromptMentions(
  document: PromptDocument,
  materialIds: ReadonlyMap<string, string>
): PromptDocument {
  return {
    version: 1,
    nodes: document.nodes.map((node) => {
      if (node.type === 'text') return node
      const materialId = materialIds.get(node.materialId)
      return materialId === undefined ? node : { type: 'mention', materialId }
    })
  }
}

export function countPromptMentions(document: PromptDocument, materialId: string): number {
  return document.nodes.filter((node) => node.type === 'mention' && node.materialId === materialId)
    .length
}

export function removePromptMentions(document: PromptDocument, materialId: string): PromptDocument {
  return normalizePromptDocument({
    version: 1,
    nodes: document.nodes.filter((node) => node.type === 'text' || node.materialId !== materialId)
  })
}

export function decodePromptDocument(value: unknown): PromptDocument | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.nodes)) {
    return null
  }

  const nodes: PromptNode[] = []
  for (const node of value.nodes) {
    if (!isRecord(node)) return null
    if (node.type === 'text' && typeof node.text === 'string') {
      nodes.push({ type: 'text', text: node.text })
      continue
    }
    if (
      node.type === 'mention' &&
      typeof node.materialId === 'string' &&
      node.materialId.length > 0
    ) {
      nodes.push({ type: 'mention', materialId: node.materialId })
      continue
    }
    return null
  }
  return normalizePromptDocument({ version: 1, nodes })
}

export function parsePromptDocument(value: unknown, fallbackPrompt: string): PromptDocument {
  return decodePromptDocument(value) ?? textPromptDocument(fallbackPrompt)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
