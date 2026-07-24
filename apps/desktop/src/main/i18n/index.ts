import { app } from 'electron'
import i18next from 'i18next'
import { createI18nOptions, type I18nEnvironment } from '../../shared/i18n/i18next-options'
import { DEFAULT_LANGUAGE_MODE, interfaceLanguageForMode } from '../../shared/i18n/language-mode'
import type { SupportedLanguage } from '../../shared/i18n/resource-contract'
import { windowResources } from './resources'

export const mainI18n = i18next.createInstance()

let interfaceLanguage: SupportedLanguage | undefined

export async function initializeMainI18n(): Promise<SupportedLanguage> {
  interfaceLanguage = interfaceLanguageForMode(DEFAULT_LANGUAGE_MODE, getSystemLanguagesAtStartup())
  await mainI18n.init(
    createI18nOptions({
      language: interfaceLanguage,
      resources: windowResources,
      defaultNS: 'window',
      environment: getMainI18nEnvironment()
    })
  )
  return interfaceLanguage
}

export function getInterfaceLanguage(): SupportedLanguage {
  if (!interfaceLanguage) {
    throw new Error('Main i18n has not been initialized')
  }
  return interfaceLanguage
}

export function getMainWindowTitle(): string {
  return mainI18n.t('title', { ns: 'window' })
}

function getSystemLanguagesAtStartup(): readonly string[] {
  if (process.env.NEVIX_E2E === '1' && !app.isPackaged) {
    const testLanguages = process.env.NEVIX_TEST_SYSTEM_LANGUAGES?.split(',')
      .map((language) => language.trim())
      .filter(Boolean)
    if (testLanguages?.length) return testLanguages
  }

  return app.getPreferredSystemLanguages()
}

export function getMainI18nEnvironment(): I18nEnvironment {
  if (app.isPackaged) return 'production'
  return process.env.NEVIX_E2E === '1' ? 'test' : 'development'
}
