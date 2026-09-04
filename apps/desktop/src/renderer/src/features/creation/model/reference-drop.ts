import type { MaterialKind } from '../api/go-creation-http'

/**
 * Payload classification and admission rules for dropping reference
 * materials onto the deck (issue #177 follow-up): which dropped files the
 * current mode's policy may accept, and how a dragged task result is
 * identified. The deck renders the verdicts; the rules are unit-testable
 * without a DOM. The server remains the authority — client-side filtering
 * only shapes what is even attempted.
 */

/** The internal drag type marking a succeeded slot result dragged from the
 * result gallery toward the reference deck (ADR-0018 reuse path). */
export const RESULT_DRAG_MIME = 'application/x-nevix-creation-result'

export interface ResultDragPayload {
  readonly taskId: string
  readonly slotIndex: number
  readonly mediaType: 'image' | 'video'
}

export function encodeResultDrag(payload: ResultDragPayload): string {
  return JSON.stringify(payload)
}

export function decodeResultDrag(data: string | null): ResultDragPayload | null {
  if (data === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { taskId, slotIndex, mediaType } = parsed as Record<string, unknown>
  if (typeof taskId !== 'string' || typeof slotIndex !== 'number') return null
  if (mediaType !== 'image' && mediaType !== 'video') return null
  return { taskId, slotIndex, mediaType }
}

// A same-document drag's payload cannot be read from dataTransfer during
// dragover (protected mode), yet the deck needs the media type up front to
// show its invite/deny verdict. The gallery records the live drag here on
// dragstart and clears it on dragend; external OS drags never touch it.
let activeResultDrag: ResultDragPayload | null = null

export function beginResultDrag(payload: ResultDragPayload): void {
  activeResultDrag = payload
}

export function endResultDrag(): void {
  activeResultDrag = null
}

export function currentResultDrag(): ResultDragPayload | null {
  return activeResultDrag
}

/** Maps a MIME type onto the material kind vocabulary; null is not a material. */
export function materialKindOfMimeType(mimeType: string): MaterialKind | null {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  return null
}

export interface FileDropPlan<T> {
  /** Files to add, in drop order, already capped. */
  readonly accepted: readonly T[]
  readonly rejectedKind: number
  readonly rejectedCap: number
}

/**
 * Admits dropped files in drop order until the deck's remaining capacity is
 * spent; files of a kind the mode does not allow are rejected outright.
 * Order matters: a valid file behind an invalid one still takes a slot.
 */
export function planFileDrop<T extends { readonly type: string }>(
  files: readonly T[],
  allowedKinds: readonly MaterialKind[],
  remainingCapacity: number
): FileDropPlan<T> {
  const allowed = new Set(allowedKinds)
  const accepted: T[] = []
  let rejectedKind = 0
  let rejectedCap = 0
  for (const file of files) {
    const kind = materialKindOfMimeType(file.type)
    if (kind === null || !allowed.has(kind)) {
      rejectedKind += 1
      continue
    }
    if (accepted.length >= remainingCapacity) {
      rejectedCap += 1
      continue
    }
    accepted.push(file)
  }
  return { accepted, rejectedKind, rejectedCap }
}

/** Whether at least one payload item would be admitted, so a hovering drag
 * should invite a drop at all. */
export function dropWouldAdmit(
  itemTypes: readonly string[],
  allowedKinds: readonly MaterialKind[],
  remainingCapacity: number
): boolean {
  const asFiles = itemTypes.map((type) => ({ type }))
  return planFileDrop(asFiles, allowedKinds, remainingCapacity).accepted.length > 0
}
