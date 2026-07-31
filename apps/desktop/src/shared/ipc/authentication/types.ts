export type PersistedSessionRead =
  | { readonly outcome: 'session'; readonly session: string }
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'storage-unavailable' }
  | { readonly outcome: 'unreadable' }

export interface PersistedSessionWrite {
  readonly outcome: 'persisted' | 'unavailable'
}

declare module '@ipc/channels' {
  interface IpcChannelMap {
    'authentication:read-session': { response: PersistedSessionRead }
    'authentication:replace-session': {
      request: { readonly session: string }
      response: PersistedSessionWrite
    }
    'authentication:clear-session': { response: void }
  }
}

export {}
