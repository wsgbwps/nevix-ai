const KEY_PREFIX = 'nevix:creation:reference-material-delete:'

export interface ReferenceMaterialDeleteRecovery {
  readonly sessionId: string
  readonly materialId: string
}

function namespace(userId: string, serverUrl: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(serverUrl)}:`
}

function keyFor(userId: string, serverUrl: string, materialId: string): string {
  return `${namespace(userId, serverUrl)}${encodeURIComponent(materialId)}`
}

export function putReferenceMaterialDeleteRecovery(
  storage: Storage,
  userId: string,
  serverUrl: string,
  recovery: ReferenceMaterialDeleteRecovery
): void {
  try {
    storage.setItem(
      keyFor(userId, serverUrl, recovery.materialId),
      JSON.stringify({ sessionId: recovery.sessionId, materialId: recovery.materialId })
    )
  } catch {
    // Persistence failure cannot prevent the immediate best-effort delete.
  }
}

export function removeReferenceMaterialDeleteRecovery(
  storage: Storage,
  userId: string,
  serverUrl: string,
  materialId: string
): void {
  try {
    storage.removeItem(keyFor(userId, serverUrl, materialId))
  } catch {
    // A repeated idempotent DELETE remains safe if local cleanup fails.
  }
}

export function listReferenceMaterialDeleteRecoveries(
  storage: Storage,
  userId: string,
  serverUrl: string
): ReferenceMaterialDeleteRecovery[] {
  const prefix = namespace(userId, serverUrl)
  const recoveries: ReferenceMaterialDeleteRecovery[] = []
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

function parseRecovery(serialized: string | null): ReferenceMaterialDeleteRecovery | null {
  if (serialized === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(serialized) as unknown
  } catch {
    return null
  }
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Object.keys(raw).some((key) => key !== 'sessionId' && key !== 'materialId')
  ) {
    return null
  }
  const candidate = raw as Record<string, unknown>
  return canonicalUUID(candidate.sessionId) && canonicalUUID(candidate.materialId)
    ? { sessionId: candidate.sessionId, materialId: candidate.materialId }
    : null
}

function canonicalUUID(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  )
}
