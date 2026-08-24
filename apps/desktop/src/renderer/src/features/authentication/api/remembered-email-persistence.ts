/**
 * The Remembered Email persistence seam, expressed in Authentication Domain
 * semantics.
 *
 * The port is internal to the Authentication Feature: production supplies the
 * IPC adapter over the main-process store (atomic writes, secure-or-memory
 * degradation), and Authentication-owned test composition supplies an
 * in-memory adapter. The implementation never sees IPC Channels, the window
 * bridge, or filesystem details — only the outcomes below.
 */

export type RememberedEmailRead =
  | {
      readonly outcome: 'remembered'
      readonly email: string
      /** Whether the store could keep the value securely or only in memory for this launch. */
      readonly persistence: 'secure' | 'memory-only'
    }
  | { readonly outcome: 'empty' }
  /** A stored value the Desktop cannot interpret; it is ignored, never shown. */
  | { readonly outcome: 'unreadable' }
  | { readonly outcome: 'unavailable' }

export type RememberedEmailReplacement =
  | { readonly outcome: 'persisted' }
  /** The value survives only in memory for this launch. */
  | { readonly outcome: 'memory-only' }
  | { readonly outcome: 'replace-failed' }

export type RememberedEmailClearance =
  | { readonly outcome: 'cleared' }
  | { readonly outcome: 'clear-failed' }

export interface RememberedEmailPersistence {
  readonly read: () => Promise<RememberedEmailRead>
  readonly replace: (email: string) => Promise<RememberedEmailReplacement>
  readonly clear: () => Promise<RememberedEmailClearance>
}
