import { BrowserWindow } from 'electron'
import { rendererEntryUrl } from '../../window/main-window'

/** Local-file writes are available only from Nevix AI's top-level renderer document. */
export function requireTrustedRendererSender(event: Electron.IpcMainInvokeEvent): void {
  const senderWindow = BrowserWindow.fromWebContents(event.sender)
  const trustedRendererUrl = rendererEntryUrl()
  const isTrusted =
    senderWindow !== null &&
    !senderWindow.isDestroyed() &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame &&
    (event.senderFrame.url === trustedRendererUrl ||
      event.senderFrame.url.startsWith(`${trustedRendererUrl}#`))

  if (!isTrusted) throw new Error('Audit Log export is available only to the trusted renderer')
}
