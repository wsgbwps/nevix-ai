import { decideOrdinaryClose, cancelUpdateInstallation } from '../ordinary-close-runtime'
import { requireTrustedTopLevelRendererSender } from '../trusted-renderer-sender'
import { parseOrdinaryCloseDecision } from './ordinary-close-contract'

export function decideOrdinaryCloseHandler(
  event: Electron.IpcMainInvokeEvent,
  request: unknown
): void {
  const ownerWindow = requireTrustedTopLevelRendererSender(
    event,
    'Ordinary close decisions are available only to the trusted renderer'
  )
  try {
    decideOrdinaryClose(ownerWindow, parseOrdinaryCloseDecision(request))
  } catch (error) {
    cancelUpdateInstallation()
    throw error
  }
}
