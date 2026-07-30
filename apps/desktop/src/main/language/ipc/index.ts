import { ipcMain } from 'electron'
import { getBootstrapHandler } from './get-bootstrap'
import { getLanguageModeHandler } from './get-language-mode'
import { setLanguageModeHandler } from './set-language-mode'

export function register(): void {
  ipcMain.handle('language:get-bootstrap', getBootstrapHandler)
  ipcMain.handle('language:get-language-mode', getLanguageModeHandler)
  ipcMain.handle('language:set-language-mode', setLanguageModeHandler)
}
