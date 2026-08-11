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
      lastUsed: '上次使用',
      inviteSection: '待加入的邀请',
      inviteLine: '{{inviter}} 邀请你加入「{{org}}」',
      accept: '接受',
      codeLabel: '邀请码',
      codeHint: '邀请码已发送到你的邮箱，6 位字符，7 天内有效。',
      codeSubmit: '验证并加入',
      codeInvalid: '邀请码不正确，还剩 {{count}} 次尝试',
      codeInvalidRetry: '邀请码不正确，请重试。',
      codeAttemptsExhausted: '邀请码已无剩余尝试次数，请请求重发。',
      codeExpired: '该邀请已过期，请请求重发。',
      codeRevoked: '该邀请已被撤销，请请求新的邀请。',
      codeInvalidated: '该邀请码已失效，请请求重发。',
      codeUnavailable: '暂时无法验证邀请码，请稍后重试。',
      unknownInviter: '组织管理员',
      unknownOrganization: '该组织',
      cancel: '取消'
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
      lastUsed: 'Last used',
      inviteSection: 'Pending invitations',
      inviteLine: '{{inviter}} invited you to join "{{org}}"',
      accept: 'Accept',
      codeLabel: 'Invitation code',
      codeHint: 'The code was emailed to you. 6 characters, valid for 7 days.',
      codeSubmit: 'Verify and join',
      codeInvalid: 'Incorrect code, {{count}} attempts left',
      codeInvalidRetry: 'Incorrect code. Try again.',
      codeAttemptsExhausted: 'This invitation code has no attempts left. Request a resend.',
      codeExpired: 'This invitation has expired. Request a resend.',
      codeRevoked: 'This invitation has been revoked. Request a new invitation.',
      codeInvalidated: 'This invitation code is no longer valid. Request a resend.',
      codeUnavailable: 'Unable to verify this invitation code. Try again shortly.',
      unknownInviter: 'An organization admin',
      unknownOrganization: 'this organization',
      cancel: 'Cancel'
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
