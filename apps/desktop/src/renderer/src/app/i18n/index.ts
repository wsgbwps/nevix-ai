import {
  defineResourceTranslations,
  type ResourceOwner
} from '../../../../shared/i18n/resource-contract'

export const appTranslations = defineResourceTranslations({
  'zh-CN': {
    heading: '使用 Nevix AI 创作'
  },
  en: {
    heading: 'Create with Nevix AI'
  }
})

export const appResources = {
  'zh-CN': { app: appTranslations['zh-CN'] },
  en: { app: appTranslations.en }
} as const

export const appResourceOwner: ResourceOwner = {
  namespace: 'app',
  resources: appTranslations
}
