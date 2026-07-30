import { ipcMain } from 'electron'
import { clearSessionHandler } from './clear-session'
import { readSessionHandler } from './read-session'
import { replaceSessionHandler } from './replace-session'

export function register(): void {
  ipcMain.handle('authentication:read-session', readSessionHandler)
  ipcMain.handle('authentication:replace-session', replaceSessionHandler)
  ipcMain.handle('authentication:clear-session', clearSessionHandler)
}
