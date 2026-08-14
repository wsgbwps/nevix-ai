import { readRememberedEmail } from '../remembered-email-store'
import { requireTrustedTopLevelRendererSender } from '../../window/trusted-renderer-sender'
import type { RememberedEmailRead } from '../../../shared/ipc/authentication/types'

export async function readRememberedEmailHandler(
  event: Electron.IpcMainInvokeEvent,
  ...args: unknown[]
): Promise<RememberedEmailRead> {
  requireTrustedTopLevelRendererSender(
    event,
    'Remembered Email storage is available only to the trusted renderer'
  )
  if (args.length !== 0) throw new Error('Remembered Email read does not accept a payload')
  return readRememberedEmail()
}
