import { decideOrdinaryClose } from '../ordinary-close-runtime'
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
  decideOrdinaryClose(ownerWindow, parseOrdinaryCloseDecision(request))
}
