import { ipcMain } from 'electron'
import { getBootstrapHandler } from './handlers/get-bootstrap'

export function register(): void {
  ipcMain.handle('i18n:get-bootstrap', getBootstrapHandler)
}
