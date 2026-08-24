import {
  defineResourceTranslations,
  type ResourceOwner
} from '../../../../../shared/i18n/resource-contract'

export const userManagementTranslations = defineResourceTranslations({
  'zh-CN': {
    users: {
      title: '用户管理',
      description: '部署实例内的全部账号（含已停用）。只有管理员可以查看和管理账号。',
      searchLabel: '搜索（邮箱或显示名）',
      createUser: '建号',
      rosterLabel: '用户列表',
      selfSuffix: '（你）',
      role: { admin: '管理员', member: '成员' },
      statusDisabled: '已停用',
      pendingPasswordChange: '待改初始密码',
      neverLoggedIn: '从未登录',
      roleSelectLabel: '更改 {{name}} 的角色',
      actionsLabel: '{{name}} 的管理操作',
      action: {
        changeEmail: '改登录邮箱',
        resetPassword: '重置密码',
        disable: '停用',
        delete: '删除'
      },
      pagination: '第 {{page}} / {{totalPages}} 页 · 共 {{total}} 个账号',
      previousPage: '上一页',
      nextPage: '下一页',
      loading: '正在读取用户列表…',
      empty: '没有匹配的账号',
      loadFailed: '无法读取用户列表。',
      retry: '重试',
      create: {
        title: '建号',
        description: '新账号为成员角色，首次登录时强制修改初始密码。',
        emailLabel: '邮箱',
        initialPasswordLabel: '初始密码',
        displayNameLabel: '显示名（可选，留空取邮箱前缀）',
        submit: '创建账号'
      },
      reset: {
        title: '重置 {{name}} 的密码',
        description: '设置新的初始密码；该账号全部会话立即失效，下次登录强制改密。',
        passwordLabel: '新初始密码',
        submit: '重置密码'
      },
      email: {
        title: '修改 {{name}} 的登录邮箱',
        description: '登录邮箱是账号的唯一标识，修改后该账号需用新邮箱登录。',
        emailLabel: '新登录邮箱',
        submit: '保存邮箱'
      },
      disable: {
        title: '停用 {{name}}',
        description: '停用后该账号全部会话立即失效、无法再登录；停用不可撤销，历史归属保留。',
        submit: '停用账号'
      },
      delete: {
        title: '删除 {{name}}',
        description: '只能删除从未登录过的账号；删除不可恢复，历史审计记录保留。',
        submit: '删除账号'
      },
      notice: {
        created: '已创建 {{email}}，首次登录时将强制修改初始密码。',
        disabled: '已停用 {{email}}，其全部会话立即失效。',
        passwordReset: '已重置 {{email}} 的密码，其全部会话已吊销。',
        emailChanged: '登录邮箱已改为 {{email}}。',
        roleChanged: '{{email}} 的角色已改为 {{role}}。',
        deleted: '已删除 {{email}}。'
      }
    },
    audit: {
      title: '审计日志',
      description: '账号与权限相关安全事件的不可变记录，按时间倒序分页。',
      listLabel: '审计条目',
      export: '导出 CSV',
      exportNotice: '已导出 {{count}} 条审计记录。',
      empty: '暂无审计记录。',
      loading: '正在读取审计日志…',
      loadFailed: '无法读取审计日志。',
      retry: '重试',
      pagination: '第 {{page}} / {{totalPages}} 页 · 共 {{total}} 条',
      previousPage: '上一页',
      nextPage: '下一页',
      noTarget: '（无对象）',
      colTime: '时间',
      colActor: '操作者',
      colAction: '动作',
      colTarget: '对象',
      colMetadata: '详情',
      actions: {
        instance_claimed: '认领实例并创建首个管理员',
        session_created: '登录',
        session_revoked: '退出登录',
        password_changed: '修改密码',
        display_name_changed: '修改显示名',
        user_created: '建号',
        user_disabled: '停用账号',
        user_password_reset: '重置密码',
        user_email_changed: '修改登录邮箱',
        user_role_changed: '调整角色',
        user_deleted: '删除账号',
        join_code_created: '签发加入码',
        join_code_revoked: '吊销加入码'
      }
    },
    joinCodes: {
      title: '加入码',
      description:
        '签发可复用的注册凭据，新成员凭它在登录屏自注册；码不随注册消耗，吊销即失效，全部活跃码被吊销则自注册关闭。',
      activeCount: '当前 {{count}} 枚活跃加入码（上限 3）',
      listLabel: '活跃加入码列表',
      empty: '暂无活跃加入码，自注册已关闭。',
      loading: '正在读取加入码…',
      loadFailed: '无法读取加入码。',
      retry: '重试',
      unlabeled: '无备注',
      createdAt: '签发于 {{time}}',
      copy: {
        actionLabel: '复制 {{code}}',
        copiedLabel: '已复制 {{code}}'
      },
      issue: {
        title: '签发加入码',
        description: '生成一枚 8 位加入码，签发后立即可见明文，可直接分发给新成员。',
        labelLabel: '备注（可选，如码贴到哪个群）',
        submit: '签发加入码'
      },
      revoke: {
        title: '吊销加入码 {{code}}',
        description: '吊销后该码立即失效且不可恢复；列表不再显示，审计记录保留。',
        submit: '吊销',
        actionLabel: '吊销 {{code}}'
      },
      notice: {
        created: '已签发加入码 {{code}}，明文见下方列表。',
        revoked: '已吊销该加入码，其注册通道立即关闭。'
      }
    },
    common: { cancel: '取消' },
    errors: {
      networkFailure: '无法连接服务器，请稍后重试。',
      unauthorized: '当前会话已失效，请重新登录。',
      forbidden: '当前账号不再是管理员。',
      codeFallback: '操作失败（{{code}}），请重试。',
      codes: {
        invalid_request: '请求不完整，请检查后重试。',
        invalid_email: '邮箱格式不正确。',
        password_too_short: '密码至少 8 个字符。',
        invalid_display_name: '显示名过长（最多 128 个字符）。',
        invalid_role: '角色不合法。',
        invalid_pagination: '分页参数不合法，请刷新。',
        invalid_search: '搜索词过长。',
        email_taken: '该邮箱已被另一个账号使用。',
        user_not_found: '目标账号不存在，请刷新列表。',
        last_admin_protected: '不能停用或降级最后一个活跃管理员。',
        user_has_logged_in: '该账号登录过，不能删除；请改用停用。',
        too_many_active_join_codes: '活跃加入码已达上限（3），请先吊销一枚再签发。',
        join_code_not_found: '目标加入码不存在或已吊销，请刷新列表。',
        invalid_label: '备注过长（最多 128 个字符）。',
        internal_error: '服务器内部错误，请重试。'
      }
    }
  },
  en: {
    users: {
      title: 'User management',
      description:
        'Every account on this deployment, including disabled ones. Only administrators can view and manage accounts.',
      searchLabel: 'Search (email or display name)',
      createUser: 'Create account',
      rosterLabel: 'User list',
      selfSuffix: '(you)',
      role: { admin: 'Admin', member: 'Member' },
      statusDisabled: 'Disabled',
      pendingPasswordChange: 'Initial password pending',
      neverLoggedIn: 'Never signed in',
      roleSelectLabel: 'Change role of {{name}}',
      actionsLabel: 'Manage {{name}}',
      action: {
        changeEmail: 'Change sign-in email',
        resetPassword: 'Reset password',
        disable: 'Disable',
        delete: 'Delete'
      },
      pagination: 'Page {{page}} of {{totalPages}} · {{total}} accounts',
      previousPage: 'Previous page',
      nextPage: 'Next page',
      loading: 'Loading the user list…',
      empty: 'No matching accounts',
      loadFailed: 'The user list could not be loaded.',
      retry: 'Try again',
      create: {
        title: 'Create account',
        description:
          'The new account is a member and must change the initial password at first sign-in.',
        emailLabel: 'Email',
        initialPasswordLabel: 'Initial password',
        displayNameLabel: 'Display name (optional, defaults to the email local part)',
        submit: 'Create account'
      },
      reset: {
        title: 'Reset password of {{name}}',
        description:
          'Sets a new initial password; every session of this account is revoked immediately and the next sign-in forces a change.',
        passwordLabel: 'New initial password',
        submit: 'Reset password'
      },
      email: {
        title: 'Change sign-in email of {{name}}',
        description:
          'The sign-in email is the unique account identifier; after the change the account signs in with the new email.',
        emailLabel: 'New sign-in email',
        submit: 'Save email'
      },
      disable: {
        title: 'Disable {{name}}',
        description:
          'Every session of this account is revoked immediately and the account can no longer sign in; disabling is irreversible while history stays attributed.',
        submit: 'Disable account'
      },
      delete: {
        title: 'Delete {{name}}',
        description:
          'Only accounts that never signed in can be deleted; deletion is irreversible while audit history stays intact.',
        submit: 'Delete account'
      },
      notice: {
        created: 'Created {{email}}; the initial password must be changed at first sign-in.',
        disabled: 'Disabled {{email}}; every session was revoked immediately.',
        passwordReset: 'Reset the password of {{email}}; all of its sessions were revoked.',
        emailChanged: 'The sign-in email is now {{email}}.',
        roleChanged: 'The role of {{email}} is now {{role}}.',
        deleted: 'Deleted {{email}}.'
      }
    },
    audit: {
      title: 'Audit log',
      description:
        'The immutable record of account and permission events, newest first and paginated.',
      listLabel: 'Audit entries',
      export: 'Export CSV',
      exportNotice: 'Exported {{count}} audit entries.',
      empty: 'No audit entries yet.',
      loading: 'Loading the audit log…',
      loadFailed: 'The audit log could not be loaded.',
      retry: 'Try again',
      pagination: 'Page {{page}} of {{totalPages}} · {{total}} entries',
      previousPage: 'Previous page',
      nextPage: 'Next page',
      noTarget: '(no target)',
      colTime: 'Time',
      colActor: 'Actor',
      colAction: 'Action',
      colTarget: 'Target',
      colMetadata: 'Detail',
      actions: {
        instance_claimed: 'Instance claimed — first administrator created',
        session_created: 'Sign-in',
        session_revoked: 'Sign-out',
        password_changed: 'Password changed',
        display_name_changed: 'Display name changed',
        user_created: 'Account created',
        user_disabled: 'Account disabled',
        user_password_reset: 'Password reset',
        user_email_changed: 'Sign-in email changed',
        user_role_changed: 'Role changed',
        user_deleted: 'Account deleted',
        join_code_created: 'Join code issued',
        join_code_revoked: 'Join code revoked'
      }
    },
    joinCodes: {
      title: 'Join codes',
      description:
        'Issue reusable registration credentials new members redeem at the sign-in screen; codes are not consumed by registration, only revocation ends one, and with no active code self-registration is closed.',
      activeCount: '{{count}} active join codes (limit 3)',
      listLabel: 'Active join codes',
      empty: 'No active join codes; self-registration is closed.',
      loading: 'Loading join codes…',
      loadFailed: 'The join codes could not be loaded.',
      retry: 'Try again',
      unlabeled: 'No note',
      createdAt: 'Issued {{time}}',
      copy: {
        actionLabel: 'Copy {{code}}',
        copiedLabel: 'Copied {{code}}'
      },
      issue: {
        title: 'Issue join code',
        description:
          'Generates an 8-character code; the plaintext is visible immediately and can be shared with new members.',
        labelLabel: 'Note (optional, e.g. which group the code was posted to)',
        submit: 'Issue join code'
      },
      revoke: {
        title: 'Revoke join code {{code}}',
        description:
          'Revocation takes effect immediately and cannot be undone; the code leaves the list while audit history stays.',
        submit: 'Revoke',
        actionLabel: 'Revoke {{code}}'
      },
      notice: {
        created: 'Issued join code {{code}}; the plaintext is in the list below.',
        revoked: 'The join code was revoked; its registration path is closed.'
      }
    },
    common: { cancel: 'Cancel' },
    errors: {
      networkFailure: 'The server could not be reached. Try again later.',
      unauthorized: 'This session has expired. Sign in again.',
      forbidden: 'This account is no longer an administrator.',
      codeFallback: 'The action failed ({{code}}). Try again.',
      codes: {
        invalid_request: 'The request is incomplete. Check it and try again.',
        invalid_email: 'The email address is not valid.',
        password_too_short: 'The password must be at least 8 characters.',
        invalid_display_name: 'The display name is too long (128 characters at most).',
        invalid_role: 'The role is not valid.',
        invalid_pagination: 'The pagination is invalid. Refresh.',
        invalid_search: 'The search term is too long.',
        email_taken: 'This email is already used by another account.',
        user_not_found: 'The target account no longer exists. Refresh the list.',
        last_admin_protected: 'The last active administrator cannot be disabled or demoted.',
        user_has_logged_in: 'This account has signed in and cannot be deleted; disable it instead.',
        too_many_active_join_codes:
          'The active join codes are at their limit (3); revoke one before issuing another.',
        join_code_not_found: 'The join code no longer exists or is already revoked. Refresh.',
        invalid_label: 'The note is too long (128 characters at most).',
        internal_error: 'Internal server error. Try again.'
      }
    }
  }
})

export const userManagementResources = {
  'zh-CN': { userManagement: userManagementTranslations['zh-CN'] },
  en: { userManagement: userManagementTranslations.en }
} as const

export const userManagementResourceOwner: ResourceOwner = {
  namespace: 'userManagement',
  resources: userManagementTranslations
}
