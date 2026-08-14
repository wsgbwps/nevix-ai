import type { BrowserWindow } from 'electron'
import type { OrdinaryCloseRequestedEvent } from '../../../shared/ipc/window/types'

const ordinaryCloseReadyWindows = new WeakSet<BrowserWindow>()

export function markOrdinaryCloseRendererReady(window: BrowserWindow): void {
  ordinaryCloseReadyWindows.add(window)
}

export function markOrdinaryCloseRendererUnavailable(window: BrowserWindow): void {
  ordinaryCloseReadyWindows.delete(window)
}

export function requestOrdinaryCloseDecision(
  window: BrowserWindow,
  request: OrdinaryCloseRequestedEvent
): boolean {
  if (!ordinaryCloseReadyWindows.has(window) || window.webContents.isDestroyed()) return false
  try {
    window.webContents.send('window:ordinary-close-requested', request)
    return true
  } catch {
    markOrdinaryCloseRendererUnavailable(window)
    return false
  }
}
