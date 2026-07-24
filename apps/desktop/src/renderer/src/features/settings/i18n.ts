import {
  defineResourceTranslations,
  type ResourceOwner
} from '../../../../shared/i18n/resource-contract'

export const settingsTranslations = defineResourceTranslations({
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

export const settingsResources = {
  'zh-CN': { settings: settingsTranslations['zh-CN'] },
  en: { settings: settingsTranslations.en }
} as const

export const settingsResourceOwner: ResourceOwner = {
  namespace: 'settings',
  resources: settingsTranslations
}
