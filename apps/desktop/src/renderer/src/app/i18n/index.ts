import {
  defineResourceTranslations,
  type ResourceOwner
} from '../../../../shared/i18n/resource-contract'

export const appTranslations = defineResourceTranslations({
  'zh-CN': {
    heading: '使用 Nevix AI 创作',
    shell: {
      home: '首页',
      toggleSidebar: '切换侧边栏',
      organizationSwitcher: '组织切换器',
      userMenu: '用户菜单',
      settings: '设置'
    },
    settings: {
      title: '设置',
      back: '返回应用',
      account: '账户',
      profile: '个人资料',
      language: '语言'
    }
  },
  en: {
    heading: 'Create with Nevix AI',
    shell: {
      home: 'Home',
      toggleSidebar: 'Toggle sidebar',
      organizationSwitcher: 'Organization switcher',
      userMenu: 'User menu',
      settings: 'Settings'
    },
    settings: {
      title: 'Settings',
      back: 'Back to app',
      account: 'Account',
      profile: 'Profile',
      language: 'Language'
    }
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
