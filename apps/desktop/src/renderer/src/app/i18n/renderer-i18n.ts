import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { createI18nOptions, type I18nEnvironment } from '../../../../shared/i18n/i18next-options'
import type { SupportedLanguage } from '../../../../shared/i18n/resource-contract'
import { settingsResources } from '../../features/settings'
import { appResources } from '.'

export const rendererI18n = i18next.createInstance()

export const rendererResources = {
  'zh-CN': { ...appResources['zh-CN'], ...settingsResources['zh-CN'] },
  en: { ...appResources.en, ...settingsResources.en }
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
