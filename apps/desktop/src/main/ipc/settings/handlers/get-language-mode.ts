import { getInterfaceLanguage, getLanguageMode } from '../../../i18n'
import type { LanguageModeSettings } from '../../../../shared/ipc/settings/types'

export function getLanguageModeHandler(): LanguageModeSettings {
  return {
    languageMode: getLanguageMode(),
    interfaceLanguage: getInterfaceLanguage()
  }
}
