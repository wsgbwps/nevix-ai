import { trustServerCertificate } from '../connection-store'
import { requireTrustedTopLevelRendererSender } from '../../window/trusted-renderer-sender'
import { readRequestUrl } from './test-server'
import type { ServerConnectionTrustResult } from '../../../shared/ipc/connection/types'

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/

export async function trustCertificateHandler(
  event: Electron.IpcMainInvokeEvent,
  request: unknown
): Promise<ServerConnectionTrustResult> {
  requireTrustedTopLevelRendererSender(
    event,
    'Server connection storage is available only to the trusted renderer'
  )

  if (typeof request !== 'object' || request === null) {
    throw new Error('Certificate trust received an unusable payload')
  }
  const { url, fingerprint } = request as { url?: unknown; fingerprint?: unknown }
  if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new Error('Certificate trust received an unusable fingerprint')
  }

  return trustServerCertificate(readRequestUrl({ url }), fingerprint)
}
