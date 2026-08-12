import {
  defineResourceTranslations,
  type ResourceOwner
} from '../../../../../shared/i18n/resource-contract'

export const organizationTranslations = defineResourceTranslations({
  'zh-CN': {
    common: {
      displayName: '显示名',
      displayNamePlaceholder: '其他成员看到的名字',
      orgName: '组织名称',
      orgNamePlaceholder: '例如：星云设计',
      email: '邮箱',
      emailPlaceholder: 'name@example.com',
      cancel: '取消',
      save: '保存',
      back: '返回',
      continue: '继续',
      close: '关闭',
      youSuffix: '（你）',
      roles: {
        owner: '拥有者',
        admin: '管理员',
        member: '成员'
      },
      memberCount: '{{count}} 名成员',
      validation: {
        displayNameRequired: '请输入显示名（不能为纯空白）',
        displayNameTooLong: '显示名最长 50 个字符',
        orgNameRequired: '请输入组织名称'
      }
    },
    shell: {
      switchToPicker: '全部组织'
    },
    settingsChrome: {
      groupAccount: '账户',
      groupOrg: '组织',
      languageDescription: '选择 Desktop 界面的显示语言。',
      updateOrganizationName: '应用组织改名',
      discardOrganizationName: '放弃组织改名'
    },
    members: {
      title: '成员',
      inviteCta: '邀请成员',
      inviteDialogTitle: '邀请成员',
      inviteDialogDescription: '邀请码将发送到该邮箱；对方在 Desktop 输码后加入，默认角色为成员。',
      send: '发送邀请',
      sent: '邀请已发送至 {{email}}',
      membersTab: '成员',
      invitesTab: '待定邀请',
      pendingSection: '待定邀请（{{count}}）',
      emptyInvites: '暂无待定邀请。',
      resend: '重发',
      resent: '已重发，新邀请码 7 天内有效。',
      revoke: '撤销',
      revoked: '已撤销该邀请。',
      expires: '{{days}} 天后过期',
      setAdmin: '设为管理员',
      setMember: '设为成员',
      changeRole: '变更角色',
      remove: '移除成员',
      removeTitle: '移除 {{name}}？',
      removeDescription: '移除后其访问立即结束，并会收到邮件通知。该操作会记入审计日志。',
      confirmRemove: '确认移除',
      leave: '退出组织',
      leaveTitle: '退出「{{org}}」？',
      leaveDescription: '退出后你将失去该组织的访问权限，可经再次邀请加入。',
      confirmLeave: '确认退出',
      roleUpdated: '已更新 {{name}} 的角色。',
      memberReadOnly: '成员角色仅可查看成员列表。',
      loading: '正在加载成员信息…',
      loadError: '暂时无法加载成员信息。请重试。',
      actionFailed: '操作失败，请重试。',
      activeMembershipExists: '该邮箱已是组织成员。',
      pendingInvitationExists: '该邮箱已有待定邀请。',
      cooldownActive: '请在 {{seconds}} 秒后重试。',
      invitationRateLimited: '邀请请求过于频繁，请稍后重试。',
      retry: '重试',
      retryLoadAria: '重新加载成员',
      changeRoleAria: '变更 {{name}} 的角色',
      removeAria: '移除成员 {{name}}',
      leaveAria: '{{name}} 退出组织',
      resendAria: '重发 {{email}} 的邀请',
      revokeAria: '撤销 {{email}} 的邀请'
    },
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
    },
    audit: {
      title: '审计日志',
      description: '组织安全事件，滚动保留 365 天，不可修改。',
      filterAll: '全部事件',
      export: '导出',
      exportFileName: '组织审计日志.csv',
      exported: '已导出 {{count}} 条记录。',
      accessUnavailable: '暂时无法验证你查看审计日志的权限。请重试。',
      retry: '重试',
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
    common: {
      displayName: 'Display name',
      displayNamePlaceholder: 'The name other members see',
      orgName: 'Organization name',
      orgNamePlaceholder: 'e.g. Nebula Design',
      email: 'Email',
      emailPlaceholder: 'name@example.com',
      cancel: 'Cancel',
      save: 'Save',
      back: 'Back',
      continue: 'Continue',
      close: 'Close',
      youSuffix: '(you)',
      roles: {
        owner: 'Owner',
        admin: 'Admin',
        member: 'Member'
      },
      memberCount: '{{count}} members',
      validation: {
        displayNameRequired: 'Enter a display name (not whitespace only)',
        displayNameTooLong: 'Display name is 50 characters at most',
        orgNameRequired: 'Enter an organization name'
      }
    },
    shell: {
      switchToPicker: 'All organizations'
    },
    settingsChrome: {
      groupAccount: 'Account',
      groupOrg: 'Organization',
      languageDescription: 'Choose the language used in the Desktop interface.',
      updateOrganizationName: 'Apply organization rename',
      discardOrganizationName: 'Discard organization rename'
    },
    members: {
      title: 'Members',
      inviteCta: 'Invite member',
      inviteDialogTitle: 'Invite member',
      inviteDialogDescription:
        'A code is emailed to this address. They join as a Member after entering it in Desktop.',
      send: 'Send invitation',
      sent: 'Invitation sent to {{email}}',
      membersTab: 'Members',
      invitesTab: 'Pending invitations',
      pendingSection: 'Pending invitations ({{count}})',
      emptyInvites: 'No pending invitations.',
      resend: 'Resend',
      resent: 'Resent. The new code is valid for 7 days.',
      revoke: 'Revoke',
      revoked: 'Invitation revoked.',
      expires: 'Expires in {{days}} days',
      setAdmin: 'Make Admin',
      setMember: 'Make Member',
      changeRole: 'Change role',
      remove: 'Remove member',
      removeTitle: 'Remove {{name}}?',
      removeDescription:
        'Their access ends immediately and they are notified by email. This is recorded in the audit log.',
      confirmRemove: 'Remove',
      leave: 'Leave organization',
      leaveTitle: 'Leave "{{org}}"?',
      leaveDescription:
        'You will lose access to this organization. You can rejoin with a new invitation.',
      confirmLeave: 'Leave',
      roleUpdated: 'Updated the role of {{name}}.',
      memberReadOnly: 'The Member role can only view the roster.',
      loading: 'Loading members…',
      loadError: 'Unable to load members right now. Try again.',
      actionFailed: 'The action failed. Try again.',
      activeMembershipExists: 'This email already belongs to an organization member.',
      pendingInvitationExists: 'A pending invitation already exists for this email.',
      cooldownActive: 'Try again in {{seconds}} seconds.',
      invitationRateLimited: 'Too many invitation requests. Try again later.',
      retry: 'Try again',
      retryLoadAria: 'Retry loading members',
      changeRoleAria: 'Change role for {{name}}',
      removeAria: 'Remove member {{name}}',
      leaveAria: '{{name}} leave organization',
      resendAria: 'Resend invitation to {{email}}',
      revokeAria: 'Revoke invitation to {{email}}'
    },
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
    },
    audit: {
      title: 'Audit log',
      description: 'Organization security events. Kept for 365 days, immutable.',
      filterAll: 'All events',
      export: 'Export',
      exportFileName: 'organization-audit-log.csv',
      exported: 'Exported {{count}} entries.',
      accessUnavailable: 'Unable to verify your Audit Log access right now. Try again.',
      retry: 'Try again',
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
