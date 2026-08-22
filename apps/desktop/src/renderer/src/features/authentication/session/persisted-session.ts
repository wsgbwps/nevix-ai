import type { SessionCredentials } from '../api/client'
import type { PersistedSessionRead } from '../../../../../shared/ipc/authentication/types'

/**
 * The single credential slot the main process owns: the opaque session token and its
 * server-computed expiry, encrypted at rest by the main process. The canonical stored
 * shape carries only an `{id,email}` user snapshot — the authoritative account facts
 * always come back from `/me` on restore — so reading tolerates that minimal form.
 */
export interface StoredCredentials {
  readonly token: string
  readonly expiresAt: string
}

export type PersistedCredentialsRead =
  | { readonly outcome: 'session'; readonly credentials: StoredCredentials }
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'storage-unavailable' }
  | { readonly outcome: 'unreadable' }

let persistenceUnavailable = false

export async function readPersistedCredentials(): Promise<PersistedCredentialsRead> {
  persistenceUnavailable = false
  const stored: PersistedSessionRead = await window.api.invoke('authentication:read-session')
  if (stored.outcome !== 'session') return stored

  const credentials = parseStoredSession(stored.session)
  return credentials ? { outcome: 'session', credentials } : { outcome: 'unreadable' }
}
export async function replacePersistedCredentials(
  credentials: SessionCredentials
): Promise<boolean> {
  try {
    const written = await window.api.invoke('authentication:replace-session', {
      session: serializeSession(credentials)
    })
    persistenceUnavailable = written.outcome === 'unavailable'
  } catch {
    // The current runtime keeps its in-memory session; the next launch requires signing in again.
    persistenceUnavailable = true
  }
  return !persistenceUnavailable
}

export async function clearPersistedSession(): Promise<void> {
  persistenceUnavailable = false
  await window.api.invoke('authentication:clear-session')
}

export function isSessionPersistenceUnavailable(): boolean {
  return persistenceUnavailable
}

function serializeSession(credentials: SessionCredentials): string {
  return JSON.stringify({
    token: credentials.token,
    expires_at: credentials.expiresAt,
    user: {
      id: credentials.user.id,
      email: credentials.user.email,
      display_name: credentials.user.displayName,
      role: credentials.user.role,
      must_change_password: credentials.user.mustChangePassword
    }
  })
}

function parseStoredSession(session: string): StoredCredentials | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(session)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined

  const record = parsed as Record<string, unknown>
  const token = record.token
  const expiresAt = record.expires_at
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    typeof expiresAt !== 'string' ||
    Number.isNaN(Date.parse(expiresAt))
  ) {
    return undefined
  }

  return { token, expiresAt }
}
