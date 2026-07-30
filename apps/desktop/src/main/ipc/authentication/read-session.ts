import { readPersistedSession } from '../../authentication/session-store'
import { requireTrustedRendererSender } from './trusted-sender'
import type { PersistedSessionRead } from '../../../shared/ipc/authentication/types'

export async function readSessionHandler(
  event: Electron.IpcMainInvokeEvent,
  ...args: unknown[]
): Promise<PersistedSessionRead> {
  requireTrustedRendererSender(event)
  if (args.length !== 0) throw new Error('Session read does not accept a payload')
  return readPersistedSession()
}
