import type { I18nEnvironment } from '../../i18n/i18next-options'
import type { SupportedLanguage } from '../../i18n/resource-contract'

export interface I18nBootstrap {
  readonly interfaceLanguage: SupportedLanguage
  readonly environment: I18nEnvironment
}

declare module '@ipc/channels' {
  interface IpcChannelMap {
    'i18n:get-bootstrap': { response: I18nBootstrap }
  }
}

export {}
