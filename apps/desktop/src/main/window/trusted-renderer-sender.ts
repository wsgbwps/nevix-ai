import { BrowserWindow } from 'electron'
import { rendererEntryUrl } from './main-window'
import { isTrustedTopLevelRenderer } from './trusted-renderer'

/** Rejects IPC calls that do not come from Nevix AI's canonical top-level renderer document. */
export function requireTrustedTopLevelRendererSender(
  event: Electron.IpcMainInvokeEvent,
  errorMessage: string
): BrowserWindow {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  if (
    !isTrustedTopLevelRenderer({
      ownerWindow,
      senderFrame: event.senderFrame,
      mainFrame: event.sender.mainFrame,
      trustedRendererUrl: rendererEntryUrl()
    })
  ) {
    throw new Error(errorMessage)
  }
  return ownerWindow!
}
