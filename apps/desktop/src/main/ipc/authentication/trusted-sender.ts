import { BrowserWindow } from 'electron'
import { rendererEntryUrl } from '../../window/main-window'

/**
 * TypeScript types are not a security boundary, so every Session Handler proves at runtime that the
 * call came from this application's own top-level renderer document before touching Session material.
 */
export function requireTrustedRendererSender(event: Electron.IpcMainInvokeEvent): void {
  const senderWindow = BrowserWindow.fromWebContents(event.sender)
  const isTrusted =
    senderWindow !== null &&
    !senderWindow.isDestroyed() &&
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === rendererEntryUrl()

  if (!isTrusted) throw new Error('Session storage is available only to the trusted renderer')
}
