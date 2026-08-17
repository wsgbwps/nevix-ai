import type { SupportedStorage } from '@supabase/supabase-js'
import type { PersistedSessionRead } from '../../../../../shared/ipc/authentication/types'

/** The single Session slot the main process owns; the adapter never lets Supabase pick a location. */
export const AUTHENTICATION_STORAGE_KEY = 'nevix-authentication-session'

/** supabase-js only needs a handful of live PKCE verifiers, so a small cap stops unbounded growth. */
export const MAXIMUM_TRANSIENT_KEYS = 16

let persistenceUnavailable = false
let sessionInMemory: string | null | undefined

/** Keys other than the Session slot stay in memory so they can never overwrite the Session. */
const transientValues = new Map<string, string>()

function rememberTransientValue(key: string, value: string): void {
  // Re-inserting refreshes recency, then the oldest entries fall off past the cap.
  transientValues.delete(key)
  transientValues.set(key, value)
  while (transientValues.size > MAXIMUM_TRANSIENT_KEYS) {
    const oldestKey = transientValues.keys().next().value
    if (oldestKey === undefined) break
    transientValues.delete(oldestKey)
  }
}

export async function readPersistedSession(): Promise<PersistedSessionRead> {
  const stored = await window.api.invoke('authentication:read-session')
  sessionInMemory = stored.outcome === 'session' ? stored.session : null
  return stored
}

export async function clearPersistedSession(): Promise<void> {
  sessionInMemory = null
  persistenceUnavailable = false
  await window.api.invoke('authentication:clear-session')
}

export function isSessionPersistenceUnavailable(): boolean {
  return persistenceUnavailable
}

function hasAccessToken(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value)
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { access_token?: unknown }).access_token === 'string' &&
      (parsed as { access_token: string }).access_token.length > 0
    )
  } catch {
    return false
  }
}

export const persistedSessionStorage: SupportedStorage = {
  async getItem(key) {
    if (key !== AUTHENTICATION_STORAGE_KEY) return transientValues.get(key) ?? null
    if (sessionInMemory !== undefined) return sessionInMemory

    const stored = await readPersistedSession()
    return stored.outcome === 'session' ? stored.session : null
  },

  async setItem(key, value) {
    if (key !== AUTHENTICATION_STORAGE_KEY) {
      rememberTransientValue(key, value)
      return
    }

    sessionInMemory = value
    if (!hasAccessToken(value)) return
    try {
      const written = await window.api.invoke('authentication:replace-session', { session: value })
      persistenceUnavailable = written.outcome === 'unavailable'
    } catch {
      // The current runtime keeps its in-memory Session; the next launch requires signing in again.
      persistenceUnavailable = true
    }
  },

  async removeItem(key) {
    if (key !== AUTHENTICATION_STORAGE_KEY) {
      transientValues.delete(key)
      return
    }

    await clearPersistedSession()
  }
}
