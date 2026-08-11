import {
  defineResourceTranslations,
  type ResourceOwner
} from '../../../../../shared/i18n/resource-contract'

export const organizationTranslations = defineResourceTranslations({
  'zh-CN': {
    startup: {
      restoring: '正在恢复你的工作区…'
    },
    picker: {
      heading: '选择组织',
      subheading: '选择一个组织进入工作区，设备会记住你上次的选择。',
      signedInAs: '已登录 {{email}}',
      createOrg: '创建新组织',
      signOut: '退出登录',
      lastUsed: '上次使用'
    },
    onboarding: {
      stepLabel: '第 {{current}} 步，共 {{total}} 步',
      profileHeading: '你怎么称呼？',
      profileDescription: '显示名会在所有组织中展示给其他成员，之后可以随时修改。',
      orgHeading: '创建你的第一个组织',
      orgDescription: '业务资源归组织所有；组织名称之后可以修改。',
      displayName: '显示名',
      displayNamePlaceholder: '其他成员看到的名字',
      orgName: '组织名称',
      orgNamePlaceholder: '例如：星云设计',
      next: '继续',
      back: '上一步',
      submit: '创建组织并进入',
      validation: {
        displayNameRequired: '请输入显示名（不能为纯空白）',
        displayNameTooLong: '显示名最长 50 个字符',
        orgNameRequired: '请输入组织名称'
      }
    },
    audit: {
      title: '审计日志',
      settingsGroup: '组织',
      description: '组织安全事件，滚动保留 365 天，不可修改。',
      filterAll: '全部事件',
      export: '导出',
      exportFileName: '组织审计日志.csv',
      exported: '已导出 {{count}} 条记录。',
      colTime: '时间',
      colActor: '操作者',
      colAction: '动作',
      colTarget: '对象',
      colDetail: '详情',
      today: '今天',
      yesterday: '昨天',
      actions: {
        invitationCreated: '发出邀请',
        invitationResent: '重发邀请',
        invitationRevoked: '撤销邀请',
        invitationAccepted: '接受邀请',
        membershipLeft: '退出组织',
        memberRemoved: '移除成员',
        adminPromoted: '晋升为管理员',
        adminDemoted: '降级管理员',
        adminRemoved: '移除管理员',
        organizationSettingsUpdated: '更新组织设置'
      }
    }
  },
  en: {
    startup: {
      restoring: 'Restoring your workspace…'
    },
    picker: {
      heading: 'Select an organization',
      subheading: 'Pick an organization to enter. This device remembers your last choice.',
      signedInAs: 'Signed in as {{email}}',
      createOrg: 'Create new organization',
      signOut: 'Sign out',
      lastUsed: 'Last used'
    },
    onboarding: {
      stepLabel: 'Step {{current}} of {{total}}',
      profileHeading: 'What should we call you?',
      profileDescription:
        'Your display name is shown to other members in every organization. You can change it later.',
      orgHeading: 'Create your first organization',
      orgDescription: 'Business resources belong to organizations. You can rename it later.',
      displayName: 'Display name',
      displayNamePlaceholder: 'The name other members see',
      orgName: 'Organization name',
      orgNamePlaceholder: 'e.g. Nebula Design',
      next: 'Continue',
      back: 'Back',
      submit: 'Create organization and enter',
      validation: {
        displayNameRequired: 'Enter a display name (not whitespace only)',
        displayNameTooLong: 'Display name is 50 characters at most',
        orgNameRequired: 'Enter an organization name'
      }
    },
    audit: {
      title: 'Audit log',
      settingsGroup: 'Organization',
      description: 'Organization security events. Kept for 365 days, immutable.',
      filterAll: 'All events',
      export: 'Export',
      exportFileName: 'organization-audit-log.csv',
      exported: 'Exported {{count}} entries.',
      colTime: 'Time',
      colActor: 'Actor',
      colAction: 'Action',
      colTarget: 'Target',
      colDetail: 'Detail',
      today: 'Today',
      yesterday: 'Yesterday',
      actions: {
        invitationCreated: 'Invitation created',
        invitationResent: 'Invitation resent',
        invitationRevoked: 'Invitation revoked',
        invitationAccepted: 'Invitation accepted',
        membershipLeft: 'Left organization',
        memberRemoved: 'Removed member',
        adminPromoted: 'Promoted to admin',
        adminDemoted: 'Demoted from admin',
        adminRemoved: 'Removed admin',
        organizationSettingsUpdated: 'Updated organization settings'
      }
    }
  }
})

export const organizationResources = {
  'zh-CN': { organization: organizationTranslations['zh-CN'] },
  en: { organization: organizationTranslations.en }
} as const

export const organizationResourceOwner: ResourceOwner = {
  namespace: 'organization',
  resources: organizationTranslations
}
