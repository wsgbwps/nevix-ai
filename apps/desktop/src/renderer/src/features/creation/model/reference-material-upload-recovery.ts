import type { CreationReferenceMaterialUploadRecovery } from '../../../../../shared/ipc/creation/types'

const KEY_PREFIX = 'nevix:creation:reference-upload-recovery:'

function namespace(userId: string, serverUrl: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(serverUrl)}:`
}

function keyFor(userId: string, serverUrl: string, idempotencyKey: string): string {
  return `${namespace(userId, serverUrl)}${encodeURIComponent(idempotencyKey)}`
}

export function putReferenceMaterialUploadRecovery(
  storage: Storage,
  userId: string,
  serverUrl: string,
  recovery: CreationReferenceMaterialUploadRecovery
): void {
  const safe: CreationReferenceMaterialUploadRecovery = {
    ...(recovery.uploadId === undefined ? {} : { uploadId: recovery.uploadId }),
    idempotencyKey: recovery.idempotencyKey,
    sessionId: recovery.sessionId,
    fileName: recovery.fileName,
    declaredKind: recovery.declaredKind,
    declaredMimeType: recovery.declaredMimeType,
    declaredByteSize: recovery.declaredByteSize,
    ...(recovery.putExpiresAt === undefined ? {} : { putExpiresAt: recovery.putExpiresAt }),
    ...(recovery.finalizeExpiresAt === undefined
      ? {}
      : { finalizeExpiresAt: recovery.finalizeExpiresAt })
  }
  try {
    storage.setItem(keyFor(userId, serverUrl, recovery.idempotencyKey), JSON.stringify(safe))
  } catch {
    // Unavailable local persistence degrades recovery, never upload authority.
  }
}

export function removeReferenceMaterialUploadRecovery(
  storage: Storage,
  userId: string,
  serverUrl: string,
  idempotencyKey: string
): void {
  try {
    storage.removeItem(keyFor(userId, serverUrl, idempotencyKey))
  } catch {
    // Removal is hygiene; a later status-first recovery remains safe.
  }
}

export function listReferenceMaterialUploadRecoveries(
  storage: Storage,
  userId: string,
  serverUrl: string
): CreationReferenceMaterialUploadRecovery[] {
  const prefix = namespace(userId, serverUrl)
  const recoveries: CreationReferenceMaterialUploadRecovery[] = []
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key === null || !key.startsWith(prefix)) continue
      const recovery = parseRecovery(storage.getItem(key))
      if (recovery === null) {
        storage.removeItem(key)
        index -= 1
        continue
      }
      recoveries.push(recovery)
    }
  } catch {
    return []
  }
  return recoveries
}

function parseRecovery(serialized: string | null): CreationReferenceMaterialUploadRecovery | null {
  if (serialized === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(serialized) as unknown
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  const allowed = new Set([
    'uploadId',
    'idempotencyKey',
    'sessionId',
    'fileName',
    'declaredKind',
    'declaredMimeType',
    'declaredByteSize',
    'putExpiresAt',
    'finalizeExpiresAt'
  ])
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null
  if (
    !nonempty(raw.idempotencyKey) ||
    !nonempty(raw.sessionId) ||
    !nonempty(raw.fileName) ||
    (raw.declaredKind !== 'image' &&
      raw.declaredKind !== 'video' &&
      raw.declaredKind !== 'audio') ||
    !nonempty(raw.declaredMimeType) ||
    typeof raw.declaredByteSize !== 'number' ||
    !Number.isSafeInteger(raw.declaredByteSize) ||
    raw.declaredByteSize <= 0
  ) {
    return null
  }
  const serverFacts = [raw.uploadId, raw.putExpiresAt, raw.finalizeExpiresAt]
  if (!serverFacts.every((value) => value === undefined) && !serverFacts.every(nonempty))
    return null
  return {
    ...(raw.uploadId === undefined ? {} : { uploadId: raw.uploadId as string }),
    idempotencyKey: raw.idempotencyKey,
    sessionId: raw.sessionId,
    fileName: raw.fileName,
    declaredKind: raw.declaredKind,
    declaredMimeType: raw.declaredMimeType,
    declaredByteSize: raw.declaredByteSize,
    ...(raw.putExpiresAt === undefined ? {} : { putExpiresAt: raw.putExpiresAt as string }),
    ...(raw.finalizeExpiresAt === undefined
      ? {}
      : { finalizeExpiresAt: raw.finalizeExpiresAt as string })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
