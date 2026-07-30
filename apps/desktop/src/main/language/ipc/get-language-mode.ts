import { getInterfaceLanguage, getLanguageMode } from '../interface-language'
import type { LanguageModeState } from '../../../shared/ipc/language/types'

export function getLanguageModeHandler(): LanguageModeState {
  return {
    languageMode: getLanguageMode(),
    interfaceLanguage: getInterfaceLanguage()
  }
}
