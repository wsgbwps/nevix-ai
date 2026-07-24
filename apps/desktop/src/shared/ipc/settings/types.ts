import type { LanguageMode } from '../../i18n/language-mode'
import type { SupportedLanguage } from '../../i18n/resource-contract'

export interface LanguageModeSettings {
  readonly languageMode: LanguageMode
  readonly interfaceLanguage: SupportedLanguage
}

declare module '@ipc/channels' {
  interface IpcChannelMap {
    'settings:get-language-mode': { response: LanguageModeSettings }
    'settings:set-language-mode': {
      request: { languageMode: LanguageMode }
      response: LanguageModeSettings
    }
  }

  interface IpcEventMap {
    'settings:language-mode-changed': LanguageModeSettings
  }
}

export {}
