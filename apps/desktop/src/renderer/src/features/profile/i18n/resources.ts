import {
  defineResourceTranslations,
  type ResourceOwner
} from '../../../../../shared/i18n/resource-contract'

export const profileTranslations = defineResourceTranslations({
  'zh-CN': {
    navLabel: '个人资料',
    title: '个人资料',
    description: '显示名在所有组织中共享；登录邮箱不属于个人资料。',
    displayName: '显示名',
    displayNamePlaceholder: '其他成员看到的名字',
    save: '保存',
    cancel: '取消',
    saved: '显示名已更新。',
    validation: {
      displayNameRequired: '请输入显示名（不能为纯空白）',
      displayNameTooLong: '显示名最长 50 个字符'
    }
  },
  en: {
    navLabel: 'Profile',
    title: 'Profile',
    description:
      'Your display name is shared across organizations. Your sign-in email is not part of the profile.',
    displayName: 'Display name',
    displayNamePlaceholder: 'The name other members see',
    save: 'Save',
    cancel: 'Cancel',
    saved: 'Display name updated.',
    validation: {
      displayNameRequired: 'Enter a display name (not whitespace only)',
      displayNameTooLong: 'Display name is 50 characters at most'
    }
  }
})

export const profileResources = {
  'zh-CN': { profile: profileTranslations['zh-CN'] },
  en: { profile: profileTranslations.en }
} as const

export const profileResourceOwner: ResourceOwner = {
  namespace: 'profile',
  resources: profileTranslations
}
