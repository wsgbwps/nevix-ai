/**
 * The production Session persistence adapter: the Domain port over the
 * main-process encrypted slot. IPC Channels, the window bridge, and the
 * stored JSON shape stay here; callers see only Domain outcomes.
 */
import type { SessionCredentials } from '../api/go-authentication'
import type {
  SessionClearance,
  SessionPersistence,
  SessionReplacement,
  StoredSessionCredentials,
  StoredSessionRead
} from './session-persistence'
import type { PersistedSessionRead } from '../../../../../shared/ipc/authentication/types'

export function createSessionPersistenceOverIpc(): SessionPersistence {
  return {
    async read(): Promise<StoredSessionRead> {
      const stored: PersistedSessionRead = await readOverIpc()
      if (stored.outcome !== 'session') {
        if (stored.outcome === 'storage-unavailable') return { outcome: 'unavailable' }
        return stored
      }

      const credentials = parseStoredSession(stored.session)
      return credentials ? { outcome: 'stored', credentials } : { outcome: 'unreadable' }
    },

    async replace(session: SessionCredentials): Promise<SessionReplacement> {
      try {
        const written = await window.api.invoke('authentication:replace-session', {
          session: serializeSession(session)
        })
        // The current runtime keeps its in-memory session; the next launch requires signing in again.
        return written.outcome === 'persisted'
          ? { outcome: 'persisted' }
          : { outcome: 'unavailable' }
      } catch {
        return { outcome: 'unavailable' }
      }
    },

    async clear(): Promise<SessionClearance> {
      try {
        await window.api.invoke('authentication:clear-session')
        return { outcome: 'cleared' }
      } catch {
        return { outcome: 'clear-failed' }
      }
    }
  }
}

async function readOverIpc(): Promise<PersistedSessionRead> {
  try {
    return await window.api.invoke('authentication:read-session')
  } catch {
    // An unreachable store is retryable: the stored session is kept, never guessed.
    return { outcome: 'storage-unavailable' }
  }
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

function parseStoredSession(session: string): StoredSessionCredentials | undefined {
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
