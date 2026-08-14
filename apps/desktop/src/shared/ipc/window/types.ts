export interface OrdinaryCloseRequestedEvent {
  readonly requestId: string
}

export type OrdinaryCloseDecision = 'allow' | 'cancel'

export interface DecideOrdinaryCloseRequest {
  readonly requestId: string
  readonly decision: OrdinaryCloseDecision
}

declare module '@ipc/channels' {
  interface IpcChannelMap {
    'window:ordinary-close-ready': {
      response: void
    }
    'window:decide-ordinary-close': {
      request: DecideOrdinaryCloseRequest
      response: void
    }
  }

  interface IpcEventMap {
    'window:deactivated': void
    'window:ordinary-close-requested': OrdinaryCloseRequestedEvent
  }
}

export {}
