/**
 * The production Remembered Email persistence adapter: the Domain port over
 * the main-process store. IPC Channels, the window bridge, and the stored
 * value's atomic-write and secure/memory degradation stay on the main side;
 * callers see only Domain outcomes.
 */
import type {
  RememberedEmailClearance,
  RememberedEmailPersistence,
  RememberedEmailRead,
  RememberedEmailReplacement
} from './remembered-email-persistence'
import type {
  RememberedEmailClear,
  RememberedEmailRead as WireRememberedEmailRead,
  RememberedEmailWrite
} from '../../../../../shared/ipc/authentication/types'

export function createRememberedEmailPersistenceOverIpc(): RememberedEmailPersistence {
  return {
    async read(): Promise<RememberedEmailRead> {
      let stored: WireRememberedEmailRead
      try {
        stored = await window.api.invoke('authentication:read-remembered-email')
      } catch {
        return { outcome: 'unavailable' }
      }

      if (stored.outcome === 'email') {
        return { outcome: 'remembered', email: stored.email, persistence: stored.persistence }
      }
      if (stored.outcome === 'storage-unavailable') return { outcome: 'unavailable' }
      return stored
    },

    async replace(email): Promise<RememberedEmailReplacement> {
      try {
        const written: RememberedEmailWrite = await window.api.invoke(
          'authentication:replace-remembered-email',
          { email }
        )
        return written.outcome === 'persisted'
          ? { outcome: 'persisted' }
          : { outcome: 'memory-only' }
      } catch {
        return { outcome: 'replace-failed' }
      }
    },

    async clear(): Promise<RememberedEmailClearance> {
      try {
        const cleared: RememberedEmailClear = await window.api.invoke(
          'authentication:clear-remembered-email'
        )
        return cleared
      } catch {
        return { outcome: 'clear-failed' }
      }
    }
  }
}
