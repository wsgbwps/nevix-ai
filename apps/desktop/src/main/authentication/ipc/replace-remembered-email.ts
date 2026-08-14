import { replaceRememberedEmail } from '../remembered-email-store'
import { requireTrustedTopLevelRendererSender } from '../../window/trusted-renderer-sender'
import type { RememberedEmailWrite } from '../../../shared/ipc/authentication/types'

const MAXIMUM_EMAIL_BYTES = 320

export async function replaceRememberedEmailHandler(
  event: Electron.IpcMainInvokeEvent,
  request: unknown,
  ...extraArguments: unknown[]
): Promise<RememberedEmailWrite> {
  requireTrustedTopLevelRendererSender(
    event,
    'Remembered Email storage is available only to the trusted renderer'
  )

  const keys = typeof request === 'object' && request !== null ? Object.keys(request) : []
  const email = keys.length === 1 ? (request as { email?: unknown }).email : undefined
  if (
    extraArguments.length !== 0 ||
    typeof email !== 'string' ||
    Buffer.byteLength(email, 'utf8') === 0 ||
    Buffer.byteLength(email, 'utf8') > MAXIMUM_EMAIL_BYTES
  ) {
    throw new Error('Remembered Email storage received an unusable email')
  }

  return replaceRememberedEmail(email)
}
