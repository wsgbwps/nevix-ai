import { readServerConnection } from '../connection-store'
import { requireTrustedTopLevelRendererSender } from '../../window/trusted-renderer-sender'
import type { ServerConnectionRead } from '../../../shared/ipc/connection/types'

export async function readServerHandler(
  event: Electron.IpcMainInvokeEvent,
  ...args: unknown[]
): Promise<ServerConnectionRead> {
  requireTrustedTopLevelRendererSender(
    event,
    'Server connection storage is available only to the trusted renderer'
  )
  if (args.length !== 0) throw new Error('Server connection read does not accept a payload')
  return readServerConnection()
}
