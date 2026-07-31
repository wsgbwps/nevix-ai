import { BrowserWindow } from 'electron'
import { getMainWindowTitle, setLanguageMode } from '../interface-language'
import { getLanguageModeHandler } from './get-language-mode'
import type { LanguageMode } from '../../../shared/i18n/language-mode'
import type { LanguageModeState } from '../../../shared/ipc/language/types'

export async function setLanguageModeHandler(
  _: Electron.IpcMainInvokeEvent,
  { languageMode }: { languageMode: LanguageMode }
): Promise<LanguageModeState> {
  await setLanguageMode(languageMode)
  const state = getLanguageModeHandler()

  for (const window of BrowserWindow.getAllWindows()) {
    window.setTitle(getMainWindowTitle())
    window.webContents.send('language:language-mode-changed', state)
  }

  return state
}
