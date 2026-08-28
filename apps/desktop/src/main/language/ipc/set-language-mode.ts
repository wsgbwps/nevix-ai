import { BrowserWindow } from 'electron'
import { getMainWindowTitle, setLanguageMode } from '../interface-language'
import { refreshApplicationMenu } from '../../window/native-editing'
import { getLanguageModeHandler } from './get-language-mode'
import type { LanguageMode } from '../../../shared/i18n/language-mode'
import type { LanguageModeState } from '../../../shared/ipc/language/types'

export async function setLanguageModeHandler(
  _: Electron.IpcMainInvokeEvent,
  { languageMode }: { languageMode: LanguageMode }
): Promise<LanguageModeState> {
  await setLanguageMode(languageMode)
  // 应用菜单的顶级标签（编辑）随语言重建；窗口内文案由 renderer 刷新。
  refreshApplicationMenu()
  const state = getLanguageModeHandler()

  for (const window of BrowserWindow.getAllWindows()) {
    window.setTitle(getMainWindowTitle())
    window.webContents.send('language:language-mode-changed', state)
  }

  return state
}
