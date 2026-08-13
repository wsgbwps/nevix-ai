import { ipcMain } from 'electron'
import { decideOrdinaryCloseHandler } from './decide-ordinary-close'

export function register(): void {
  ipcMain.handle('window:decide-ordinary-close', decideOrdinaryCloseHandler)
}
