import { getInterfaceLanguage, getMainI18nEnvironment } from '../interface-language'
import type { LanguageBootstrap } from '../../../shared/ipc/language/types'

export function getBootstrapHandler(): LanguageBootstrap {
  return {
    interfaceLanguage: getInterfaceLanguage(),
    environment: getMainI18nEnvironment()
  }
}
