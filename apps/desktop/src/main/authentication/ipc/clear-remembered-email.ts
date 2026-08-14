import { clearRememberedEmail } from '../remembered-email-store'
import { requireTrustedTopLevelRendererSender } from '../../window/trusted-renderer-sender'
import type { RememberedEmailClear } from '../../../shared/ipc/authentication/types'

export async function clearRememberedEmailHandler(
  event: Electron.IpcMainInvokeEvent,
  ...args: unknown[]
): Promise<RememberedEmailClear> {
  requireTrustedTopLevelRendererSender(
    event,
    'Remembered Email storage is available only to the trusted renderer'
  )
  if (args.length !== 0) throw new Error('Remembered Email clear does not accept a payload')
  return clearRememberedEmail()
}
