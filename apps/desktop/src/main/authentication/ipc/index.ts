import { ipcMain } from 'electron'
import { clearSessionHandler } from './clear-session'
import { clearRememberedEmailHandler } from './clear-remembered-email'
import { readSessionHandler } from './read-session'
import { readRememberedEmailHandler } from './read-remembered-email'
import { replaceSessionHandler } from './replace-session'
import { replaceRememberedEmailHandler } from './replace-remembered-email'

export function register(): void {
  ipcMain.handle('authentication:clear-remembered-email', clearRememberedEmailHandler)
  ipcMain.handle('authentication:read-session', readSessionHandler)
  ipcMain.handle('authentication:read-remembered-email', readRememberedEmailHandler)
  ipcMain.handle('authentication:replace-session', replaceSessionHandler)
  ipcMain.handle('authentication:replace-remembered-email', replaceRememberedEmailHandler)
  ipcMain.handle('authentication:clear-session', clearSessionHandler)
}
