import { ipcMain } from 'electron'
import { readServerHandler } from './read-server'
import { testServerHandler } from './test-server'
import { saveServerHandler } from './save-server'
import { trustCertificateHandler } from './trust-certificate'

export function register(): void {
  ipcMain.handle('connection:read-server', readServerHandler)
  ipcMain.handle('connection:test-server', testServerHandler)
  ipcMain.handle('connection:save-server', saveServerHandler)
  ipcMain.handle('connection:trust-certificate', trustCertificateHandler)
}
