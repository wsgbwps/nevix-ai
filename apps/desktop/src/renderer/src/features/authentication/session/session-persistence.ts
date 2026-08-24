/**
 * The current-device Session persistence seam, expressed in Authentication
 * Domain semantics.
 *
 * The port is internal to the Authentication Feature: production supplies the
 * IPC adapter over the encrypted main-process slot, and Authentication-owned
 * test composition supplies an in-memory adapter. The implementation never
 * sees IPC Channels, the window bridge, safeStorage, or the filesystem — only
 * the read/replace/clear outcomes below.
 */
import type { SessionCredentials } from '../api/go-authentication'

/** The minimal credential slot the current device persists; account facts always come back from validation. */
export interface StoredSessionCredentials {
  readonly token: string
  readonly expiresAt: string
}

export type StoredSessionRead =
  | { readonly outcome: 'stored'; readonly credentials: StoredSessionCredentials }
  /** No stored session: the ordinary unauthenticated surface. */
  | { readonly outcome: 'empty' }
  /** A stored session the Desktop cannot interpret; it is removed rather than trusted. */
  | { readonly outcome: 'unreadable' }
  /** The store could not be reached; the stored session is kept and the read stays retryable. */
  | { readonly outcome: 'unavailable' }

export type SessionReplacement =
  /** The encrypted slot holds the session for the next launch. */
  | { readonly outcome: 'persisted' }
  /** The write could not complete; the live session continues, the next launch requires signing in. */
  | { readonly outcome: 'unavailable' }

export type SessionClearance =
  | { readonly outcome: 'cleared' }
  | { readonly outcome: 'clear-failed' }

export interface SessionPersistence {
  readonly read: () => Promise<StoredSessionRead>
  readonly replace: (session: SessionCredentials) => Promise<SessionReplacement>
  readonly clear: () => Promise<SessionClearance>
}
