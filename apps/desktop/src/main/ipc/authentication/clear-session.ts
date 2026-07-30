import { clearPersistedSession } from '../../authentication/session-store'
import { requireTrustedRendererSender } from './trusted-sender'

export async function clearSessionHandler(
  event: Electron.IpcMainInvokeEvent,
  ...args: unknown[]
): Promise<void> {
  requireTrustedRendererSender(event)
  if (args.length !== 0) throw new Error('Session clear does not accept a payload')
  await clearPersistedSession()
}
