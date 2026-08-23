import {
  defineResourceTranslations,
  type ResourceOwner
} from '../../../../../shared/i18n/resource-contract'

export const authenticationTranslations = defineResourceTranslations({
  'zh-CN': {
    restoring: {
      heading: '正在初始化认证',
      description: '确认登录状态前不会显示应用内容。'
    },
    restoreFailure: {
      heading: '暂时无法恢复登录状态',
      description: '网络或服务器暂时不可用。本机登录状态已保留，可稍后重试。',
      retry: '重试'
    },
    sessionPersistence: {
      unavailable: '此设备无法安全保存登录状态，关闭应用后需要重新登录。'
    },
    rememberedEmailPersistence: {
      unavailable: '此设备无法安全保存记住的邮箱。本次选择仅在关闭应用前有效。'
    },
    passwordPolicy: {
      recommendation: '建议使用 12 个以上字符。',
      tooShort: '密码太短。',
      tooLong: '密码太长。',
      invalidPassword: '新密码不符合要求。'
    },
    passwordVisibility: {
      show: '显示输入内容',
      hide: '隐藏输入内容'
    },
    login: {
      heading: '登录 Nevix AI',
      description: '使用你的邮箱和密码继续。',
      sessionExpired: '登录状态已失效，请重新登录。',
      remoteSignOutDelayed: '此设备已退出登录。服务端撤销可能延迟，稍后会自动生效。',
      email: '邮箱',
      rememberEmail: '记住邮箱',
      rememberEmailAria: '记住登录地址',
      password: '密码',
      submit: '登录',
      submitting: '正在登录…',
      invalidCredentials: '邮箱或密码错误',
      accountDisabled: '此账号已被停用，请联系管理员。',
      rateLimited: '尝试过于频繁，请稍后重试。',
      serviceError: '无法连接服务器，请检查网络后重试。'
    },
    register: {
      heading: '注册 Nevix AI',
      description: '凭管理员发放的加入码注册你的账号。',
      email: '邮箱',
      password: '密码',
      joinCode: '加入码',
      displayName: '显示名（可选）',
      submit: '注册',
      submitting: '正在注册…',
      backToLogin: '返回登录',
      switchToRegister: '凭加入码注册账号',
      invalidJoinCode: '加入码无效或已失效，请联系管理员。',
      emailTaken: '该邮箱已被注册。',
      rateLimited: '尝试过于频繁，请稍后重试。',
      serviceError: '无法连接服务器，请检查网络后重试。'
    },
    passwordChange: {
      heading: '设置新密码',
      description: '管理员为你设置了初始密码。首次登录需要设置自己的新密码后继续使用。',
      currentPassword: '初始密码',
      newPassword: '新密码',
      confirmPassword: '确认新密码',
      confirmPasswordMismatch: '两次输入的密码不一致',
      submit: '更新密码并继续',
      submitting: '正在更新…',
      signOutInstead: '暂不修改，退出登录',
      invalidCurrentPassword: '初始密码不正确',
      rateLimited: '请求过于频繁，请稍后再试。',
      serviceError: '暂时无法更新密码，请稍后重试。'
    },
    logout: {
      submit: '退出当前设备',
      submitting: '正在退出…'
    },
    theme: {
      switchToLight: '切换到浅色主题',
      switchToDark: '切换到深色主题'
    }
  },
  en: {
    restoring: {
      heading: 'Initializing authentication',
      description: 'Application content stays hidden until your session is checked.'
    },
    restoreFailure: {
      heading: 'Your session could not be restored yet',
      description:
        'The network or the server is temporarily unavailable. Your session is still stored on this device.',
      retry: 'Try again'
    },
    sessionPersistence: {
      unavailable:
        'This device cannot store your session securely, so you will sign in again after closing the application.'
    },
    rememberedEmailPersistence: {
      unavailable:
        'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
    },
    passwordPolicy: {
      recommendation: 'We recommend using 12 or more characters.',
      tooShort: 'Password is too short.',
      tooLong: 'Password is too long.',
      invalidPassword: 'The new password does not meet the requirements.'
    },
    passwordVisibility: {
      show: 'Show entered value',
      hide: 'Hide entered value'
    },
    login: {
      heading: 'Sign in to Nevix AI',
      description: 'Continue with your email address and password.',
      sessionExpired: 'Your session is no longer valid. Sign in again.',
      remoteSignOutDelayed:
        'This device is signed out. Revoking the session on the server may be delayed.',
      email: 'Email',
      rememberEmail: 'Remember email',
      rememberEmailAria: 'Remember sign-in address',
      password: 'Password',
      submit: 'Sign in',
      submitting: 'Signing in…',
      invalidCredentials: 'Email or password is incorrect',
      accountDisabled: 'This account has been disabled. Contact your administrator.',
      rateLimited: 'Too many attempts. Try again later.',
      serviceError: 'The server cannot be reached. Check your network and try again.'
    },
    register: {
      heading: 'Register with Nevix AI',
      description: 'Register your account with the join code your administrator shared.',
      email: 'Email',
      password: 'Password',
      joinCode: 'Join code',
      displayName: 'Display name (optional)',
      submit: 'Register',
      submitting: 'Registering…',
      backToLogin: 'Back to sign in',
      switchToRegister: 'Register with a join code',
      invalidJoinCode: 'The join code is not valid. Contact your administrator.',
      emailTaken: 'This email is already registered.',
      rateLimited: 'Too many attempts. Try again later.',
      serviceError: 'The server cannot be reached. Check your network and try again.'
    },
    passwordChange: {
      heading: 'Set a new password',
      description:
        'Your administrator set an initial password. Set your own new password before continuing.',
      currentPassword: 'Initial password',
      newPassword: 'New password',
      confirmPassword: 'Confirm new password',
      confirmPasswordMismatch: 'Passwords do not match',
      submit: 'Update password and continue',
      submitting: 'Updating…',
      signOutInstead: 'Sign out without changing',
      invalidCurrentPassword: 'The initial password is incorrect',
      rateLimited: 'Too many requests. Try again later.',
      serviceError: 'The password cannot be updated right now. Try again later.'
    },
    logout: {
      submit: 'Sign out of this device',
      submitting: 'Signing out…'
    },
    theme: {
      switchToLight: 'Switch to light theme',
      switchToDark: 'Switch to dark theme'
    }
  }
})

export const authenticationResources = {
  'zh-CN': { authentication: authenticationTranslations['zh-CN'] },
  en: { authentication: authenticationTranslations.en }
} as const

export const authenticationResourceOwner: ResourceOwner = {
  namespace: 'authentication',
  resources: authenticationTranslations
}
