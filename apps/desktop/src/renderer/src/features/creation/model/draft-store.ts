/**
 * The device-local Draft store (ADR-0017): the editable draft lives only on
 * the current device, keyed per account and per session (`new` for a
 * composition that has not materialized a session yet). Writes are
 * synchronous and write-through — a renderer reload or app restart loses
 * nothing — and reads fail closed: a corrupted or foreign payload is dropped,
 * never guessed at. Multi-device drafts never sync; the server sees the
 * intent only at submission.
 */
import { parseDraftRecordShape, type LocalDraftRecord } from '../api/go-creation-http'

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
    return parseDraftRecordShape(JSON.parse(raw))
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
        }))
      })
    )
  } catch {
    // A full or unavailable store never breaks editing: the draft stays in
    // memory for this run and simply does not survive a restart.
  }
}

export function removeLocalDraft(storage: Storage, userId: string, key: string): void {
  try {
    storage.removeItem(storageKey(userId, key))
  } catch {
    // Removal is hygiene; an unavailable store carries nothing anyway.
  }
}
