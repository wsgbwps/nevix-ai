import { BrowserWindow } from 'electron'
import { getMainWindowTitle, setLanguageMode } from '../../../i18n'
import { getLanguageModeHandler } from './get-language-mode'
import type { LanguageMode } from '../../../../shared/i18n/language-mode'
import type { LanguageModeSettings } from '../../../../shared/ipc/settings/types'

export async function setLanguageModeHandler(
  _: Electron.IpcMainInvokeEvent,
  { languageMode }: { languageMode: LanguageMode }
): Promise<LanguageModeSettings> {
  await setLanguageMode(languageMode)
  const settings = getLanguageModeHandler()

  for (const window of BrowserWindow.getAllWindows()) {
    window.setTitle(getMainWindowTitle())
    window.webContents.send('settings:language-mode-changed', settings)
  }

  return settings
}
