import {
  defineResourceTranslations,
  type ResourceOwner
} from '../../../../shared/i18n/resource-contract'

export const appTranslations = defineResourceTranslations({
  'zh-CN': {
    heading: '使用 Nevix AI 创作',
    shell: {
      home: '首页',
      creation: 'AI 创作',
      toggleSidebar: '切换侧边栏',
      brand: 'Nevix AI',
      userMenu: '用户菜单',
      settings: '设置',
      theme: {
        light: '浅色模式',
        dark: '深色模式'
      }
    },
    settings: {
      title: '设置',
      back: '返回应用',
      account: '账户',
      profile: '个人资料',
      language: '语言',
      server: '服务器',
      connection: '服务器连接',
      administration: '管理',
      users: '用户管理',
      audit: '审计日志',
      discard: {
        title: '丢弃未保存的更改？',
        description: '离开当前设置将丢弃你的草稿。',
        continueEditing: '继续编辑',
        discardChanges: '丢弃更改'
      }
    }
  },
  en: {
    heading: 'Create with Nevix AI',
    shell: {
      home: 'Home',
      creation: 'AI Creation',
      toggleSidebar: 'Toggle sidebar',
      brand: 'Nevix AI',
      userMenu: 'User menu',
      settings: 'Settings',
      theme: {
        light: 'Light mode',
        dark: 'Dark mode'
      }
    },
    settings: {
      title: 'Settings',
      back: 'Back to app',
      account: 'Account',
      profile: 'Profile',
      language: 'Language',
      server: 'Server',
      connection: 'Server connection',
      administration: 'Administration',
      users: 'User management',
      audit: 'Audit log',
      discard: {
        title: 'Discard unsaved changes?',
        description: 'Leaving these settings will discard your draft.',
        continueEditing: 'Continue editing',
        discardChanges: 'Discard changes'
      }
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
