/** The server connection state a device persists in its userData directory. */
export type ServerConnectionRead =
  | { readonly state: 'configured'; readonly url: string }
  | { readonly state: 'unconfigured' }

export interface ServerConnectionProbeRequest {
  readonly url: string
}

/** What the user must see to decide on a certificate that failed standard verification. */
export interface CertificateFingerprintView {
  /** SHA-256 of the DER-encoded certificate, lowercase hex. */
  readonly fingerprint: string
  readonly subjectName: string
  readonly issuerName: string
  readonly validTo: string
}

export type ServerConnectionProbe =
  | { readonly outcome: 'reachable' }
  | { readonly outcome: 'invalid-url' }
  | { readonly outcome: 'unreachable' }
  | ({ readonly outcome: 'certificate-confirmation-required' } & CertificateFingerprintView)
  | ({ readonly outcome: 'certificate-changed' } & CertificateFingerprintView)

export interface ServerConnectionSaveRequest {
  readonly url: string
}

export type ServerConnectionSaveResult =
  | { readonly outcome: 'saved' }
  | { readonly outcome: 'invalid-url' }
  | { readonly outcome: 'unavailable' }

export interface ServerConnectionTrustRequest {
  readonly url: string
  readonly fingerprint: string
}

export type ServerConnectionTrustResult =
  | { readonly outcome: 'trusted' }
  | { readonly outcome: 'invalid-url' }
  | { readonly outcome: 'unavailable' }

declare module '@ipc/channels' {
  interface IpcChannelMap {
    'connection:read-server': { response: ServerConnectionRead }
    'connection:test-server': {
      request: ServerConnectionProbeRequest
      response: ServerConnectionProbe
    }
    'connection:save-server': {
      request: ServerConnectionSaveRequest
      response: ServerConnectionSaveResult
    }
    'connection:trust-certificate': {
      request: ServerConnectionTrustRequest
      response: ServerConnectionTrustResult
    }
  }
}

export {}
