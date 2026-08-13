import type { BrowserWindow } from 'electron'
import type { OrdinaryCloseRequestedEvent } from '../../../shared/ipc/window/types'

export function requestOrdinaryCloseDecision(
  window: BrowserWindow,
  request: OrdinaryCloseRequestedEvent
): boolean {
  if (window.webContents.isDestroyed()) return false
  window.webContents.send('window:ordinary-close-requested', request)
  return true
}
