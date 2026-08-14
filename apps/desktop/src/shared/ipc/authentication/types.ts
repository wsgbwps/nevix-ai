export type PersistedSessionRead =
  | { readonly outcome: 'session'; readonly session: string }
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'storage-unavailable' }
  | { readonly outcome: 'unreadable' }

export interface PersistedSessionWrite {
  readonly outcome: 'persisted' | 'unavailable'
}

export type RememberedEmailRead =
  | {
      readonly outcome: 'email'
      readonly email: string
      readonly persistence: 'secure' | 'memory-only'
    }
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'storage-unavailable' }
  | { readonly outcome: 'unreadable' }

export interface RememberedEmailWrite {
  readonly outcome: 'persisted' | 'memory-only'
}

export interface RememberedEmailClear {
  readonly outcome: 'cleared' | 'clear-failed'
}

declare module '@ipc/channels' {
  interface IpcChannelMap {
    'authentication:read-session': { response: PersistedSessionRead }
    'authentication:replace-session': {
      request: { readonly session: string }
      response: PersistedSessionWrite
    }
    'authentication:clear-session': { response: void }
    'authentication:read-remembered-email': { response: RememberedEmailRead }
    'authentication:replace-remembered-email': {
      request: { readonly email: string }
      response: RememberedEmailWrite
    }
    'authentication:clear-remembered-email': { response: RememberedEmailClear }
  }
}

export {}
