import type { InitOptions, Resource } from 'i18next'
import { FALLBACK_LANGUAGE, SUPPORTED_LANGUAGES, type SupportedLanguage } from './resource-contract'

export type I18nEnvironment = 'development' | 'production' | 'test'

interface I18nOptionsInput {
  readonly language: SupportedLanguage
  readonly resources: Resource
  readonly defaultNS: string
  readonly environment: I18nEnvironment
}

export function createI18nOptions({
  language,
  resources,
  defaultNS,
  environment
}: I18nOptionsInput): InitOptions {
  const isProduction = environment === 'production'

  return {
    lng: language,
    resources,
    supportedLngs: SUPPORTED_LANGUAGES,
    fallbackLng: isProduction ? FALLBACK_LANGUAGE : false,
    defaultNS,
    interpolation: { escapeValue: false },
    returnNull: false,
    parseMissingKeyHandler: isProduction
      ? undefined
      : (key) => {
          throw new Error(`Missing translation key: ${key}`)
        }
  }
}
