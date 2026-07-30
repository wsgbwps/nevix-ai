import { app } from 'electron'
import i18next from 'i18next'
import { createI18nOptions, type I18nEnvironment } from '../../shared/i18n/i18next-options'
import {
  DEFAULT_LANGUAGE_MODE,
  interfaceLanguageForMode,
  isLanguageMode,
  type LanguageMode
} from '../../shared/i18n/language-mode'
import type { SupportedLanguage } from '../../shared/i18n/resource-contract'
import { loadLanguageMode, saveLanguageMode } from './language-mode-store'
import { windowResources } from './resources'

export const mainI18n = i18next.createInstance()

let languageMode: LanguageMode = DEFAULT_LANGUAGE_MODE
let interfaceLanguage: SupportedLanguage | undefined
let systemLanguagesAtStartup: readonly string[] | undefined

export async function initializeMainI18n(): Promise<SupportedLanguage> {
  languageMode = await loadLanguageMode()
  systemLanguagesAtStartup = getSystemLanguagesAtStartup()
  interfaceLanguage = interfaceLanguageForMode(languageMode, systemLanguagesAtStartup)
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

export function getLanguageMode(): LanguageMode {
  return languageMode
}

export async function setLanguageMode(nextLanguageMode: unknown): Promise<void> {
  if (!isLanguageMode(nextLanguageMode)) {
    throw new Error('Invalid Language Mode')
  }

  await saveLanguageMode(nextLanguageMode)
  languageMode = nextLanguageMode
  interfaceLanguage = interfaceLanguageForMode(nextLanguageMode, getSystemLanguagesAtStartupValue())
  await mainI18n.changeLanguage(interfaceLanguage)
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

function getSystemLanguagesAtStartupValue(): readonly string[] {
  if (!systemLanguagesAtStartup) {
    throw new Error('Main i18n has not been initialized')
  }
  return systemLanguagesAtStartup
}

export function getMainI18nEnvironment(): I18nEnvironment {
  if (app.isPackaged) return 'production'
  return process.env.NEVIX_E2E === '1' ? 'test' : 'development'
}
