const KEY_PREFIX = 'nevix:creation:reference-material-delete:'

function namespace(userId: string, serverUrl: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(serverUrl)}:`
}

/** Retire every legacy DELETE replay fact, including malformed entries. */
export function clearReferenceMaterialDeleteRecoveries(
  storage: Storage,
  userId: string,
  serverUrl: string
): void {
  const prefix = namespace(userId, serverUrl)
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key === null || !key.startsWith(prefix)) continue
      storage.removeItem(key)
      index -= 1
    }
  } catch {
    // A blocked storage area cannot prevent the runtime from starting.
  }
}
