/**
 * The device-local Draft store (ADR-0017): the editable draft lives only on
 * the current device, keyed per account and per session (`new` for a
 * composition that has not materialized a session yet). Writes are
 * synchronous and write-through — a renderer reload or app restart loses
 * nothing — and reads fail closed: a corrupted or foreign payload is dropped,
 * never guessed at. Multi-device drafts never sync; the server sees the
 * intent only at submission.
 */
import type { DraftReferenceRole, DraftReferenceView } from '../api/go-creation-http'
import { parsePromptDocument, remapPromptMentions, type PromptDocument } from './prompt-document'

export interface LocalDraftRecord {
  readonly prompt: string
  readonly promptDocument: PromptDocument
  readonly mediaType: 'image' | 'video' | null
  readonly manifestVersion: number
  readonly model: string | null
  readonly mode: string | null
  readonly ratio: string | null
  readonly resolution: string | null
  readonly quantity: number | null
  readonly durationSeconds: number | null
  readonly references: DraftReferenceView[]
  readonly operationNotice?: LocalDraftOperationNotice
}

export interface LocalDraftOperationNotice {
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
  const raw = storage.getItem(storageKey(userId, key))
  if (raw === null) return null
  try {
    return parseLocalDraftRecord(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeLocalDraft(
  storage: Storage,
  userId: string,
  key: string,
  record: LocalDraftRecord
): void {
  try {
    storage.setItem(
      storageKey(userId, key),
      JSON.stringify({
        prompt: record.prompt,
        prompt_document: record.promptDocument,
        media_type: record.mediaType,
        manifest_version: record.manifestVersion,
        model: record.model,
        mode: record.mode,
        ratio: record.ratio,
        resolution: record.resolution,
        quantity: record.quantity,
        duration_seconds: record.durationSeconds,
        references: record.references.map((reference) => ({
          material_id: reference.materialId,
          role: reference.role
        })),
        ...(record.operationNotice === undefined
          ? {}
          : {
              operation_notice: {
                kind: 'unconfirmed-writes',
                submission_unconfirmed: record.operationNotice.submissionUnconfirmed,
                material_file_names: record.operationNotice.materialFileNames
              }
            })
      })
    )
  } catch {
    // A full or unavailable store never breaks editing: the draft stays in
    // memory for this run and simply does not survive a restart.
  }
}

function parseLocalDraftRecord(payload: unknown): LocalDraftRecord | null {
  if (!isRecord(payload)) return null
  const prompt = stringField(payload, 'prompt')
  const manifestVersion = numberField(payload, 'manifest_version')
  const mediaType = nullableString(payload, 'media_type')
  const model = nullableString(payload, 'model')
  const mode = nullableString(payload, 'mode')
  const ratio = nullableString(payload, 'ratio')
  const resolution = nullableString(payload, 'resolution')
  const quantity = nullableNumber(payload, 'quantity')
  const durationSeconds = nullableNumber(payload, 'duration_seconds')
  const operationNotice = parseOperationNotice(payload.operation_notice)
  if (
    prompt === null ||
    manifestVersion === undefined ||
    manifestVersion < 1 ||
    mediaType === undefined ||
    (mediaType !== null && mediaType !== 'image' && mediaType !== 'video') ||
    model === undefined ||
    mode === undefined ||
    ratio === undefined ||
    resolution === undefined ||
    quantity === undefined ||
    durationSeconds === undefined ||
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
    mediaType,
    manifestVersion,
    model,
    mode,
    ratio,
    resolution,
    quantity,
    durationSeconds,
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
    return { submissionUnconfirmed: true, materialFileNames: [] }
  }
  if (value.kind === 'material-upload-unconfirmed' && typeof value.file_name === 'string') {
    return { submissionUnconfirmed: false, materialFileNames: [value.file_name] }
  }
  if (
    value.kind === 'unconfirmed-writes' &&
    typeof value.submission_unconfirmed === 'boolean' &&
    Array.isArray(value.material_file_names) &&
    value.material_file_names.every((fileName) => typeof fileName === 'string')
  ) {
    const materialFileNames = [...new Set(value.material_file_names)]
    if (!value.submission_unconfirmed && materialFileNames.length === 0) return null
    return {
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

function nullableString(source: Record<string, unknown>, field: string): string | null | undefined {
  if (!(field in source)) return undefined
  const value = source[field]
  return value === null || typeof value === 'string' ? value : undefined
}

function nullableNumber(source: Record<string, unknown>, field: string): number | null | undefined {
  if (!(field in source)) return undefined
  const value = source[field]
  return value === null || (typeof value === 'number' && Number.isFinite(value)) ? value : undefined
}

export function removeLocalDraft(storage: Storage, userId: string, key: string): void {
  try {
    storage.removeItem(storageKey(userId, key))
  } catch {
    // Removal is hygiene; an unavailable store carries nothing anyway.
  }
}

export function setLocalDraftOperationNotice(
  storage: Storage,
  userId: string,
  key: string,
  notice: LocalDraftOperationNotice | null
): void {
  const record = readLocalDraft(storage, userId, key)
  if (record === null) return
  writeLocalDraft(storage, userId, key, {
    ...record,
    operationNotice: notice ?? undefined
  })
}

export function remapLocalDraftMaterial(
  storage: Storage,
  userId: string,
  key: string,
  localId: string,
  materialId: string
): void {
  const record = readLocalDraft(storage, userId, key)
  if (record === null) return
  const idMap = new Map([[localId, materialId]])
  writeLocalDraft(storage, userId, key, {
    ...record,
    promptDocument: remapPromptMentions(record.promptDocument, idMap),
    references: record.references.map((reference) =>
      reference.materialId === localId ? { ...reference, materialId } : reference
    )
  })
}

export function replaceLocalDraftMaterial(
  storage: Storage,
  userId: string,
  key: string,
  previousMaterialId: string,
  materialId: string,
  role: DraftReferenceRole
): void {
  const record = readLocalDraft(storage, userId, key)
  if (record === null) return
  if (!record.references.some((reference) => reference.materialId === previousMaterialId)) return
  const idMap = new Map([[previousMaterialId, materialId]])
  writeLocalDraft(storage, userId, key, {
    ...record,
    promptDocument: remapPromptMentions(record.promptDocument, idMap),
    references: record.references.map((reference) =>
      reference.materialId === previousMaterialId ? { materialId, role } : reference
    )
  })
}
