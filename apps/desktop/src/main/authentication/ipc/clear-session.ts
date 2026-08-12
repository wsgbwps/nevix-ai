import { clearPersistedSession } from '../session-store'
import { requireTrustedTopLevelRendererSender } from '../../window/trusted-renderer-sender'

export async function clearSessionHandler(
  event: Electron.IpcMainInvokeEvent,
  ...args: unknown[]
): Promise<void> {
  requireTrustedTopLevelRendererSender(
    event,
    'Session storage is available only to the trusted renderer'
  )
  if (args.length !== 0) throw new Error('Session clear does not accept a payload')
  await clearPersistedSession()
}
