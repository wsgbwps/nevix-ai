import { requireTrustedTopLevelRendererSender } from '../trusted-renderer-sender'
import { markOrdinaryCloseRendererReady } from './request-ordinary-close'

export function ordinaryCloseReadyHandler(event: Electron.IpcMainInvokeEvent): void {
  const ownerWindow = requireTrustedTopLevelRendererSender(
    event,
    'Ordinary close readiness is available only to the trusted renderer'
  )
  markOrdinaryCloseRendererReady(ownerWindow)
}
