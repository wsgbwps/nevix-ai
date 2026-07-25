import { getInterfaceLanguage, getMainI18nEnvironment } from '../../../i18n'
import type { I18nBootstrap } from '../../../../shared/ipc/i18n/types'

export function getBootstrapHandler(): I18nBootstrap {
  return {
    interfaceLanguage: getInterfaceLanguage(),
    environment: getMainI18nEnvironment()
  }
}
