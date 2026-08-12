import { readPersistedSession } from '../session-store'
import { requireTrustedTopLevelRendererSender } from '../../window/trusted-renderer-sender'
import type { PersistedSessionRead } from '../../../shared/ipc/authentication/types'

export async function readSessionHandler(
  event: Electron.IpcMainInvokeEvent,
  ...args: unknown[]
): Promise<PersistedSessionRead> {
  requireTrustedTopLevelRendererSender(
    event,
    'Session storage is available only to the trusted renderer'
  )
  if (args.length !== 0) throw new Error('Session read does not accept a payload')
  return readPersistedSession()
}
