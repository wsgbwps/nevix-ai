import type { I18nEnvironment } from '../../i18n/i18next-options'
import type { LanguageMode } from '../../i18n/language-mode'
import type { SupportedLanguage } from '../../i18n/resource-contract'

export interface LanguageBootstrap {
  readonly interfaceLanguage: SupportedLanguage
  readonly environment: I18nEnvironment
}

export interface LanguageModeState {
  readonly languageMode: LanguageMode
  readonly interfaceLanguage: SupportedLanguage
}

export interface SetLanguageModeRequest {
  readonly languageMode: LanguageMode
}

declare module '@ipc/channels' {
  interface IpcChannelMap {
    'language:get-bootstrap': { response: LanguageBootstrap }
    'language:get-language-mode': { response: LanguageModeState }
    'language:set-language-mode': {
      request: SetLanguageModeRequest
      response: LanguageModeState
    }
  }

  interface IpcEventMap {
    'language:language-mode-changed': LanguageModeState
  }
}

export {}
