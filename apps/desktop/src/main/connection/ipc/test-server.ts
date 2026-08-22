import { probeServerConnection } from '../probe'
import { currentCertificatePins } from '../connection-store'
import { requireTrustedTopLevelRendererSender } from '../../window/trusted-renderer-sender'
import type { ServerConnectionProbe } from '../../../shared/ipc/connection/types'

export async function testServerHandler(
  event: Electron.IpcMainInvokeEvent,
  request: unknown
): Promise<ServerConnectionProbe> {
  requireTrustedTopLevelRendererSender(
    event,
    'Server connection probing is available only to the trusted renderer'
  )

  const url = readRequestUrl(request)
  return probeServerConnection(url, currentCertificatePins())
}

export function readRequestUrl(request: unknown): string {
  if (typeof request !== 'object' || request === null) {
    throw new Error('Server connection probe received an unusable payload')
  }
  const url = (request as { url?: unknown }).url
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) {
    throw new Error('Server connection probe received an unusable payload')
  }
  return url
}
