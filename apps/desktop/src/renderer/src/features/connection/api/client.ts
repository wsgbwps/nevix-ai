import type {
  ServerConnectionProbe,
  ServerConnectionRead,
  ServerConnectionSaveResult,
  ServerConnectionTrustResult
} from '../../../../../shared/ipc/connection/types'

export function readServerConnection(): Promise<ServerConnectionRead> {
  return window.api.invoke('connection:read-server')
}

export function testServerConnection(url: string): Promise<ServerConnectionProbe> {
  return window.api.invoke('connection:test-server', { url })
}

export function saveServerConnection(url: string): Promise<ServerConnectionSaveResult> {
  return window.api.invoke('connection:save-server', { url })
}

export function trustServerCertificate(
  url: string,
  fingerprint: string
): Promise<ServerConnectionTrustResult> {
  return window.api.invoke('connection:trust-certificate', { url, fingerprint })
}
