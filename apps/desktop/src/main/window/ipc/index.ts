import { ipcMain } from 'electron'
import { decideOrdinaryCloseHandler } from './decide-ordinary-close'
import { ordinaryCloseReadyHandler } from './ordinary-close-ready'

export function register(): void {
  ipcMain.handle('window:decide-ordinary-close', decideOrdinaryCloseHandler)
  ipcMain.handle('window:ordinary-close-ready', ordinaryCloseReadyHandler)
}
