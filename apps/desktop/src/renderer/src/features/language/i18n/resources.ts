import {
  defineResourceTranslations,
  type ResourceOwner
} from '../../../../../shared/i18n/resource-contract'

export const languageTranslations = defineResourceTranslations({
  'zh-CN': {
    heading: '界面语言',
    followSystem: '跟随系统',
    zhCN: '简体中文',
    en: 'English'
  },
  en: {
    heading: 'Interface language',
    followSystem: 'Follow system',
    zhCN: 'Simplified Chinese',
    en: 'English'
  }
})

export const languageResources = {
  'zh-CN': { language: languageTranslations['zh-CN'] },
  en: { language: languageTranslations.en }
} as const

export const languageResourceOwner: ResourceOwner = {
  namespace: 'language',
  resources: languageTranslations
}
