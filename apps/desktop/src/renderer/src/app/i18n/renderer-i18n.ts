import i18next, { type i18n as I18n } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { createI18nOptions, type I18nEnvironment } from '../../../../shared/i18n/i18next-options'
import type { SupportedLanguage } from '../../../../shared/i18n/resource-contract'
import { creationResources } from '../../features/creation'
import { authenticationResources } from '../../features/authentication'
import { connectionResources } from '../../features/connection'
import { languageResources } from '../../features/language'
import { profileResources } from '../../features/profile'
import { userManagementResources } from '../../features/user-management'
import { appResources } from '.'

export const rendererI18n: I18n = i18next.createInstance()

export const rendererResources = {
  'zh-CN': {
    ...appResources['zh-CN'],
    ...authenticationResources['zh-CN'],
    ...connectionResources['zh-CN'],
    ...languageResources['zh-CN'],
    ...profileResources['zh-CN'],
    ...userManagementResources['zh-CN'],
    ...creationResources['zh-CN']
  },
  en: {
    ...appResources.en,
    ...authenticationResources.en,
    ...connectionResources.en,
    ...languageResources.en,
    ...profileResources.en,
    ...userManagementResources.en,
    ...creationResources['en']
  }
} as const

export async function initializeRendererI18n(
  interfaceLanguage: SupportedLanguage,
  environment: I18nEnvironment
): Promise<void> {
  await rendererI18n.use(initReactI18next).init(
    createI18nOptions({
      language: interfaceLanguage,
      resources: rendererResources,
      defaultNS: 'app',
      environment
    })
  )
}
