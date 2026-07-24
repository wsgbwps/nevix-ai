import { ipcMain } from 'electron'
import { getLanguageModeHandler } from './handlers/get-language-mode'
import { setLanguageModeHandler } from './handlers/set-language-mode'

export function register(): void {
  ipcMain.handle('settings:get-language-mode', getLanguageModeHandler)
  ipcMain.handle('settings:set-language-mode', setLanguageModeHandler)
}
