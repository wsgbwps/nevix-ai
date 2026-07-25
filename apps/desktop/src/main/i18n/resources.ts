import { defineResourceTranslations, type ResourceOwner } from '../../shared/i18n/resource-contract'

export const windowTranslations = defineResourceTranslations({
  'zh-CN': {
    title: 'Nevix AI — 桌面端'
  },
  en: {
    title: 'Nevix AI — Desktop'
  }
})

export const windowResources = {
  'zh-CN': { window: windowTranslations['zh-CN'] },
  en: { window: windowTranslations.en }
} as const

export const windowResourceOwner: ResourceOwner = {
  namespace: 'window',
  resources: windowTranslations
}
