import { replacePersistedSession } from '../session-store'
import { requireTrustedTopLevelRendererSender } from '../../window/trusted-renderer-sender'
import type { PersistedSessionWrite } from '../../../shared/ipc/authentication/types'

/** An opaque session with its account snapshot is well under a kilobyte; larger is not one. */
const MAXIMUM_SESSION_LENGTH = 64 * 1024

export async function replaceSessionHandler(
  event: Electron.IpcMainInvokeEvent,
  request: unknown
): Promise<PersistedSessionWrite> {
  requireTrustedTopLevelRendererSender(
    event,
    'Session storage is available only to the trusted renderer'
  )

  const keys = typeof request === 'object' && request !== null ? Object.keys(request) : []
  const session = keys.length === 1 ? (request as { session?: unknown }).session : undefined

  if (
    typeof session !== 'string' ||
    session.length === 0 ||
    session.length > MAXIMUM_SESSION_LENGTH
  ) {
    throw new Error('Session storage received an unusable Session payload')
  }

  return replacePersistedSession(session)
}
