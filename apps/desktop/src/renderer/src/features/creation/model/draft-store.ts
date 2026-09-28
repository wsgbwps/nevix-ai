/**
 * The device-local Draft store (ADR-0017): drafts are keyed per account and per session (`new`
 * before a session exists, `pending:<uuid>` for a submission that started before one did). Writes
 * are synchronous and write-through, so a reload or restart loses nothing; reads fail closed on a
 * corrupted or foreign payload, and drafts never sync across devices — the server sees the intent
 * only at submission.
 */

import type { DraftReferenceRole, DraftReferenceView } from '../api/go-creation-http'
import {
  emptyGenerationParameters,
  generationParameterWireValues,
  parseGenerationParameterValues,
  type DraftMediaType,
  type GenerationParameterValues
} from '../api/generation-parameter'
import {
  parsePromptDocument,
  remapPromptMentions,
  removePromptMentions,
  textPromptDocument,
  type PromptDocument
} from './prompt-document'

/** Key prefix for drafts whose submission began without a session identity. */
export const PENDING_DRAFT_KEY_PREFIX = 'pending:'

export interface LocalDraftRecord extends GenerationParameterValues {
  readonly prompt: string
  readonly promptDocument: PromptDocument
  readonly manifestVersion: number
  readonly references: DraftReferenceView[]
  readonly operationNotice?: LocalDraftOperationNotice
}

export interface LocalWorkbenchDraftRecord {
  readonly activeMediaType: DraftMediaType
  readonly drafts: Record<DraftMediaType, LocalDraftRecord>
  readonly operationNotice?: LocalDraftOperationNotice
}

/** Identifies one repeated binding while unrelated positions may move during an upload. */
export interface ReferenceBindingTarget {
  readonly materialId: string
  readonly position: number
  readonly occurrence: number
  readonly count: number
  readonly role: DraftReferenceRole
}

export function referenceBindingTarget(
  references: readonly DraftReferenceView[],
  position: number
): ReferenceBindingTarget | null {
  const reference = references[position]
  if (!reference) return null
  const matching = references
    .map((entry, index) => (entry.materialId === reference.materialId ? index : -1))
    .filter((index) => index >= 0)
  return {
    materialId: reference.materialId,
    position,
    occurrence: matching.indexOf(position),
    count: matching.length,
    role: reference.role
  }
}

export function referenceBindingPosition(
  references: readonly DraftReferenceView[],
  target: ReferenceBindingTarget
): number {
  const matching = references
    .map((entry, index) => (entry.materialId === target.materialId ? index : -1))
    .filter((index) => index >= 0)
  const position = matching[target.occurrence]
  return matching.length === target.count && references[position]?.role === target.role
    ? position
    : -1
}

export interface LocalDraftOperationNotice {
  /** A session-materialization request may have been sent but its outcome is unknown. */
  readonly sessionUnconfirmed: boolean
  readonly submissionUnconfirmed: boolean
  readonly materialFileNames: readonly string[]
}

const DRAFT_ROLES: readonly DraftReferenceRole[] = [
  'reference',
  'first_frame',
  'last_frame',
  'omni'
]

const KEY_PREFIX = 'nevix:creation:draft:'

function storageKey(userId: string, key: string): string {
  return `${KEY_PREFIX}${userId}:${key}`
}

export function readLocalDraft(
  storage: Storage,
  userId: string,
  key: string
): LocalDraftRecord | null {
  const workbench = readWorkbenchDraft(storage, userId, key)
  if (workbench === null) return null
  return {
    ...workbench.drafts[workbench.activeMediaType],
    ...(workbench.operationNotice === undefined
      ? {}
      : { operationNotice: workbench.operationNotice })
  }
}

export function writeLocalDraft(
  storage: Storage,
  userId: string,
  key: string,
  record: LocalDraftRecord
): boolean {
  const existing = readWorkbenchDraft(storage, userId, key)
  const mediaType = record.mediaType ?? existing?.activeMediaType ?? 'image'
  return writeWorkbenchDraft(storage, userId, key, {
    activeMediaType: mediaType,
    drafts: {
      image: existing?.drafts.image ?? emptyDraft('image'),
      video: existing?.drafts.video ?? emptyDraft('video'),
      [mediaType]: { ...record, mediaType }
    },
    ...(record.operationNotice === undefined
      ? existing?.operationNotice === undefined
        ? {}
        : { operationNotice: existing.operationNotice }
      : { operationNotice: record.operationNotice })
  })
}

export function readWorkbenchDraft(
  storage: Storage,
  userId: string,
  key: string
): LocalWorkbenchDraftRecord | null {
  try {
    const raw = storage.getItem(storageKey(userId, key))
    return raw === null ? null : parseWorkbenchDraft(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeWorkbenchDraft(
  storage: Storage,
  userId: string,
  key: string,
  record: LocalWorkbenchDraftRecord
): boolean {
  try {
    storage.setItem(
      storageKey(userId, key),
      JSON.stringify({
        active_media_type: record.activeMediaType,
        drafts: {
          image: draftWireRecord(record.drafts.image, 'image'),
          video: draftWireRecord(record.drafts.video, 'video')
        },
        ...(record.operationNotice === undefined
          ? {}
          : { operation_notice: noticeWireRecord(record.operationNotice) })
      })
    )
    return true
  } catch {
    // Editing stays usable when the device-local store is full or unavailable.
    return false
  }
}

function emptyDraft(mediaType: DraftMediaType): LocalDraftRecord {
  return {
    prompt: '',
    promptDocument: textPromptDocument(''),
    ...emptyGenerationParameters(),
    mediaType,
    manifestVersion: 1,
    references: []
  }
}

function draftWireRecord(
  record: LocalDraftRecord,
  mediaType: DraftMediaType
): Record<string, unknown> {
  return {
    prompt: record.prompt,
    prompt_document: record.promptDocument,
    ...generationParameterWireValues(record),
    media_type: mediaType,
    manifest_version: record.manifestVersion,
    references: record.references.map((reference) => ({
      material_id: reference.materialId,
      role: reference.role
    }))
  }
}

function noticeWireRecord(notice: LocalDraftOperationNotice): Record<string, unknown> {
  return {
    kind: 'unconfirmed-writes',
    session_unconfirmed: notice.sessionUnconfirmed,
    submission_unconfirmed: notice.submissionUnconfirmed,
    material_file_names: notice.materialFileNames
  }
}

function parseWorkbenchDraft(payload: unknown): LocalWorkbenchDraftRecord | null {
  if (!isRecord(payload)) return null
  if (!('drafts' in payload)) {
    const legacy = parseLocalDraftRecord(payload)
    if (legacy === null) return null
    const mediaType = legacy.mediaType ?? 'image'
    const { operationNotice, ...draft } = legacy
    return {
      activeMediaType: mediaType,
      drafts: {
        image: mediaType === 'image' ? { ...draft, mediaType } : emptyDraft('image'),
        video: mediaType === 'video' ? { ...draft, mediaType } : emptyDraft('video')
      },
      ...(operationNotice === undefined ? {} : { operationNotice })
    }
  }
  if (
    (payload.active_media_type !== 'image' && payload.active_media_type !== 'video') ||
    !isRecord(payload.drafts)
  )
    return null
  const image = parseLocalDraftRecord(payload.drafts.image)
  const video = parseLocalDraftRecord(payload.drafts.video)
  const operationNotice = parseOperationNotice(payload.operation_notice)
  if (
    image === null ||
    image.mediaType !== 'image' ||
    image.operationNotice !== undefined ||
    video === null ||
    video.mediaType !== 'video' ||
    video.operationNotice !== undefined ||
    operationNotice === null
  )
    return null
  return {
    activeMediaType: payload.active_media_type,
    drafts: { image, video },
    ...(operationNotice === undefined ? {} : { operationNotice })
  }
}

function parseLocalDraftRecord(payload: unknown): LocalDraftRecord | null {
  if (!isRecord(payload)) return null
  const prompt = stringField(payload, 'prompt')
  const manifestVersion = numberField(payload, 'manifest_version')
  const parameters = parseGenerationParameterValues(payload)
  const operationNotice = parseOperationNotice(payload.operation_notice)
  if (
    prompt === null ||
    manifestVersion === undefined ||
    manifestVersion < 1 ||
    parameters === null ||
    !Array.isArray(payload.references) ||
    operationNotice === null
  ) {
    return null
  }
  const references: DraftReferenceView[] = []
  for (const value of payload.references) {
    if (!isRecord(value)) return null
    const materialId = stringField(value, 'material_id')
    const role = stringField(value, 'role')
    if (!materialId || role === null || !DRAFT_ROLES.includes(role as DraftReferenceRole)) {
      return null
    }
    references.push({ materialId, role: role as DraftReferenceRole })
  }
  return {
    prompt,
    promptDocument: parsePromptDocument(payload.prompt_document, prompt),
    ...parameters,
    manifestVersion,
    references,
    ...(operationNotice === undefined ? {} : { operationNotice })
  }
}

function parseOperationNotice(value: unknown): LocalDraftOperationNotice | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  // Read the first #192 draft shape so an upgrade does not discard an
  // already-recorded ambiguous write.
  if (value.kind === 'submission-unconfirmed') {
    return { sessionUnconfirmed: false, submissionUnconfirmed: true, materialFileNames: [] }
  }
  if (value.kind === 'material-upload-unconfirmed' && typeof value.file_name === 'string') {
    return {
      sessionUnconfirmed: false,
      submissionUnconfirmed: false,
      materialFileNames: [value.file_name]
    }
  }
  if (
    value.kind === 'unconfirmed-writes' &&
    typeof value.submission_unconfirmed === 'boolean' &&
    Array.isArray(value.material_file_names) &&
    value.material_file_names.every((fileName) => typeof fileName === 'string')
  ) {
    // Records written before #193 carry no session_unconfirmed marker.
    const sessionUnconfirmed = value.session_unconfirmed === true
    const materialFileNames = [...new Set(value.material_file_names)]
    if (!sessionUnconfirmed && !value.submission_unconfirmed && materialFileNames.length === 0) {
      return null
    }
    return {
      sessionUnconfirmed,
      submissionUnconfirmed: value.submission_unconfirmed,
      materialFileNames
    }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringField(source: Record<string, unknown>, field: string): string | null {
  return typeof source[field] === 'string' ? source[field] : null
}

function numberField(source: Record<string, unknown>, field: string): number | undefined {
  const value = source[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function removeLocalDraft(storage: Storage, userId: string, key: string): void {
  try {
    storage.removeItem(storageKey(userId, key))
  } catch {
    // Removal is hygiene; an unavailable store carries nothing anyway.
  }
}

/** Persisted pending keys, so a fresh runtime rebuilds the temporary
 * entries after a reload. */
export function listPendingLocalDraftKeys(storage: Storage, userId: string): string[] {
  const prefix = `${KEY_PREFIX}${userId}:`
  const keys: string[] = []
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const stored = storage.key(index)
      if (stored === null || !stored.startsWith(prefix)) continue
      const key = stored.slice(prefix.length)
      if (
        key.startsWith(PENDING_DRAFT_KEY_PREFIX) &&
        readLocalDraft(storage, userId, key) !== null
      ) {
        keys.push(key)
      }
    }
  } catch {
    // An unavailable store carries no records to list.
  }
  return keys
}

/** Re-homes both drafts synchronously: no await between read, write,
 * and remove. */
export function moveLocalDraft(storage: Storage, userId: string, from: string, to: string): void {
  if (from === to) return
  const record = readWorkbenchDraft(storage, userId, from)
  if (record === null) return
  if (writeWorkbenchDraft(storage, userId, to, record)) removeLocalDraft(storage, userId, from)
}

export function setLocalDraftOperationNotice(
  storage: Storage,
  userId: string,
  key: string,
  notice: LocalDraftOperationNotice | null
): void {
  const record = readWorkbenchDraft(storage, userId, key)
  if (record === null) return
  writeWorkbenchDraft(storage, userId, key, {
    activeMediaType: record.activeMediaType,
    drafts: record.drafts,
    ...(notice === null ? {} : { operationNotice: notice })
  })
}

export function remapLocalDraftMaterial(
  storage: Storage,
  userId: string,
  key: string,
  localId: string,
  materialId: string,
  mediaType?: DraftMediaType
): void {
  const workbench = readWorkbenchDraft(storage, userId, key)
  if (workbench === null) return
  const idMap = new Map([[localId, materialId]])
  const drafts = { ...workbench.drafts }
  for (const slot of mediaType === undefined ? (['image', 'video'] as const) : [mediaType]) {
    const record = drafts[slot]
    if (!containsMaterial(record, localId)) continue
    drafts[slot] = {
      ...record,
      promptDocument: remapPromptMentions(record.promptDocument, idMap),
      references: record.references.map((reference) =>
        reference.materialId === localId ? { ...reference, materialId } : reference
      )
    }
  }
  writeWorkbenchDraft(storage, userId, key, { ...workbench, drafts })
}

export function removeLocalDraftMaterial(
  storage: Storage,
  userId: string,
  key: string,
  materialId: string,
  mediaType?: DraftMediaType
): void {
  const workbench = readWorkbenchDraft(storage, userId, key)
  if (workbench === null) return
  const drafts = { ...workbench.drafts }
  for (const slot of mediaType === undefined ? (['image', 'video'] as const) : [mediaType]) {
    const record = drafts[slot]
    if (!containsMaterial(record, materialId)) continue
    drafts[slot] = {
      ...record,
      promptDocument: removePromptMentions(record.promptDocument, materialId),
      references: record.references.filter((reference) => reference.materialId !== materialId)
    }
  }
  writeWorkbenchDraft(storage, userId, key, { ...workbench, drafts })
}

function containsMaterial(record: LocalDraftRecord, materialId: string): boolean {
  return (
    record.references.some((reference) => reference.materialId === materialId) ||
    record.promptDocument.nodes.some(
      (node) => node.type === 'mention' && node.materialId === materialId
    )
  )
}

export function replaceLocalDraftMaterial(
  storage: Storage,
  userId: string,
  key: string,
  previousMaterialId: string,
  materialId: string,
  role: DraftReferenceRole,
  target?: ReferenceBindingTarget,
  mediaType?: DraftMediaType
): void {
  const workbench = readWorkbenchDraft(storage, userId, key)
  if (workbench === null) return
  const slot = mediaType ?? workbench.activeMediaType
  const record = workbench.drafts[slot]
  const position = target === undefined ? -1 : referenceBindingPosition(record.references, target)
  if (
    (target !== undefined &&
      (position < 0 || (record.mediaType === 'video' && position !== target.position))) ||
    !record.references.some((reference) => reference.materialId === previousMaterialId)
  )
    return
  const stillBound = target !== undefined && target.count > 1
  const idMap = new Map([[previousMaterialId, materialId]])
  writeWorkbenchDraft(storage, userId, key, {
    ...workbench,
    drafts: {
      ...workbench.drafts,
      [slot]: {
        ...record,
        promptDocument: stillBound
          ? record.promptDocument
          : remapPromptMentions(record.promptDocument, idMap),
        references: record.references.map((reference, index) =>
          reference.materialId === previousMaterialId &&
          (target === undefined || index === position)
            ? { materialId, role }
            : reference
        )
      }
    }
  })
}
