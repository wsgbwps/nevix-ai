import { saveServerConnectionUrl } from '../connection-store'
import { requireTrustedTopLevelRendererSender } from '../../window/trusted-renderer-sender'
import { readRequestUrl } from './test-server'
import type { ServerConnectionSaveResult } from '../../../shared/ipc/connection/types'

export async function saveServerHandler(
  event: Electron.IpcMainInvokeEvent,
  request: unknown
): Promise<ServerConnectionSaveResult> {
  requireTrustedTopLevelRendererSender(
    event,
    'Server connection storage is available only to the trusted renderer'
  )

  return saveServerConnectionUrl(readRequestUrl(request))
}
