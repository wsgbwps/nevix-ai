import {
  defineResourceTranslations,
  type ResourceOwner
} from '../../../../../shared/i18n/resource-contract'

export const authenticationTranslations = defineResourceTranslations({
  'zh-CN': {
    configurationError: {
      heading: '认证暂不可用',
      description: '此构建缺少有效的 Supabase 或服务端公开配置。'
    },
    restoring: {
      heading: '正在初始化认证',
      description: '确认登录状态前不会显示应用内容。'
    },
    restoreFailure: {
      heading: '暂时无法恢复登录状态',
      description: '网络或认证服务暂时不可用。本机登录状态已保留，可稍后重试。',
      retry: '重试'
    },
    sessionPersistence: {
      unavailable: '此设备无法安全保存登录状态，关闭应用后需要重新登录。'
    },
    rememberedEmailPersistence: {
      unavailable: '此设备无法安全保存记住的邮箱。本次选择仅在关闭应用前有效。'
    },
    passwordVisibility: {
      show: '显示输入内容',
      hide: '隐藏输入内容'
    },
    login: {
      heading: '登录 Nevix AI',
      description: '使用已验证的邮箱继续。',
      sessionExpired: '登录状态已失效，请重新登录。',
      remoteSignOutDelayed: '此设备已退出登录。服务端撤销可能延迟，稍后会自动生效。',
      passwordUpdated: '密码已更新，请使用新密码登录。',
      passwordUpdatedRevocationDelayed: '密码已更新，但其他设备的退出可能延迟。请使用新密码登录。',
      email: '邮箱',
      rememberEmail: '记住邮箱',
      rememberEmailAria: '记住登录地址',
      password: '密码',
      submit: '登录',
      submitting: '正在登录…',
      noAccount: '还没有账号？',
      createAccount: '创建账号',
      forgotPassword: '忘记密码？',
      invalidCredentials: '邮箱或密码错误',
      rateLimited: '请求过于频繁，请稍后重试。',
      serviceError: '暂时无法登录，请稍后重试。'
    },
    signup: {
      heading: '创建你的 Nevix AI 账号',
      description: '只需邮箱和密码，无需填写个人资料或组织信息。',
      passwordBytes: '{{count}} / 12–72 UTF-8 字节',
      confirmPassword: '确认密码',
      confirmPasswordMismatch: '两次输入的密码不一致',
      submit: '创建账号',
      submitting: '正在创建账号…',
      hasAccount: '已有账号？',
      signIn: '返回登录',
      rateLimited: '请求过于频繁，请稍后再试。',
      serviceError: '暂时无法提交注册，请稍后重试。'
    },
    verification: {
      heading: '检查你的邮箱',
      description: '如果该邮箱可以用于注册，我们已发送六位验证码。',
      code: '验证码',
      codeHint: '请输入六位验证码；验证码有效期为一小时。',
      verify: '验证邮箱',
      verifying: '正在验证…',
      invalidCode: '验证码无效或已过期',
      resend: '重新发送验证码',
      resendCountdown: '{{count}} 秒后可重新发送',
      resent: '新验证码已发送，旧验证码已失效。',
      signIn: '返回登录',
      rateLimited: '请求过于频繁，请稍后再试。',
      serviceError: '暂时无法验证，请稍后重试。'
    },
    recovery: {
      request: {
        heading: '重置密码',
        description: '输入你的邮箱，我们将发送六位恢复验证码。',
        submit: '发送恢复验证码',
        submitting: '正在发送…',
        backToLogin: '返回登录',
        rateLimited: '请求过于频繁，请稍后再试。',
        serviceError: '暂时无法发送恢复验证码，请稍后重试。'
      },
      verification: {
        heading: '输入恢复验证码',
        description: '如果该邮箱已注册，我们已发送六位恢复验证码。',
        code: '恢复验证码',
        codeHint: '请输入六位恢复验证码；验证码有效期为一小时。',
        verify: '验证',
        verifying: '正在验证…',
        invalidCode: '验证码无效或已过期',
        backToLogin: '返回登录',
        rateLimited: '请求过于频繁，请稍后再试。',
        serviceError: '暂时无法验证，请稍后重试。'
      },
      newPassword: {
        heading: '设置新密码',
        description: '为你的账号设置新密码，之后需要使用新密码重新登录。',
        password: '新密码',
        passwordBytes: '{{count}} / 12–72 UTF-8 字节',
        submit: '更新密码',
        submitting: '正在更新…',
        samePassword: '新密码不能与旧密码相同',
        rateLimited: '请求过于频繁，请稍后再试。',
        serviceError: '暂时无法更新密码，请稍后重试。'
      }
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
    configurationError: {
      heading: 'Authentication is unavailable',
      description: 'This build is missing valid public Supabase or server configuration.'
    },
    restoring: {
      heading: 'Initializing authentication',
      description: 'Application content stays hidden until your session is checked.'
    },
    restoreFailure: {
      heading: 'Your session could not be restored yet',
      description:
        'The network or the authentication service is temporarily unavailable. Your session is still stored on this device.',
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
    passwordVisibility: {
      show: 'Show entered value',
      hide: 'Hide entered value'
    },
    login: {
      heading: 'Sign in to Nevix AI',
      description: 'Continue with your verified email address.',
      sessionExpired: 'Your session is no longer valid. Sign in again.',
      remoteSignOutDelayed:
        'This device is signed out. Revoking the session on the server may be delayed.',
      passwordUpdated: 'Your password was updated. Sign in with your new password.',
      passwordUpdatedRevocationDelayed:
        'Your password was updated, but signing out other devices may be delayed. Sign in with your new password.',
      email: 'Email',
      rememberEmail: 'Remember email',
      rememberEmailAria: 'Remember sign-in address',
      password: 'Password',
      submit: 'Sign in',
      submitting: 'Signing in…',
      noAccount: 'New to Nevix AI?',
      createAccount: 'Create account',
      forgotPassword: 'Forgot password?',
      invalidCredentials: 'Email or password is incorrect',
      rateLimited: 'Too many requests. Try again later.',
      serviceError: 'Sign-in is temporarily unavailable. Try again later.'
    },
    signup: {
      heading: 'Create your Nevix AI account',
      description: 'Use only your email and password. No profile or organization is required.',
      passwordBytes: '{{count}} of 12–72 UTF-8 bytes',
      confirmPassword: 'Confirm password',
      confirmPasswordMismatch: 'Passwords do not match',
      submit: 'Create account',
      submitting: 'Creating account…',
      hasAccount: 'Already have an account?',
      signIn: 'Sign in instead',
      rateLimited: 'Too many requests. Try again later.',
      serviceError: 'Sign-up is temporarily unavailable. Try again later.'
    },
    verification: {
      heading: 'Check your email',
      description: 'If this email can be used to sign up, we sent a six-digit verification code.',
      code: 'Verification code',
      codeHint: 'Enter the six-digit code. It expires in one hour.',
      verify: 'Verify email',
      verifying: 'Verifying…',
      invalidCode: 'Verification code is invalid or expired',
      resend: 'Resend code',
      resendCountdown: 'Resend in {{count}}s',
      resent: 'A new code was sent. Your previous code is no longer valid.',
      signIn: 'Go to sign in',
      rateLimited: 'Too many requests. Try again later.',
      serviceError: 'Verification is temporarily unavailable. Try again later.'
    },
    recovery: {
      request: {
        heading: 'Reset your password',
        description: 'Enter your email and we will send a six-digit recovery code.',
        submit: 'Send recovery code',
        submitting: 'Sending…',
        backToLogin: 'Back to sign in',
        rateLimited: 'Too many requests. Try again later.',
        serviceError: 'The recovery code cannot be sent right now. Try again later.'
      },
      verification: {
        heading: 'Enter your recovery code',
        description: 'If this email is registered, we sent a six-digit recovery code.',
        code: 'Recovery code',
        codeHint: 'Enter the six-digit recovery code. It expires in one hour.',
        verify: 'Verify code',
        verifying: 'Verifying…',
        invalidCode: 'Recovery code is invalid or expired',
        backToLogin: 'Back to sign in',
        rateLimited: 'Too many requests. Try again later.',
        serviceError: 'Verification is temporarily unavailable. Try again later.'
      },
      newPassword: {
        heading: 'Set a new password',
        description:
          'Choose a new password for your account, then sign in again with the new password.',
        password: 'New password',
        passwordBytes: '{{count}} of 12–72 UTF-8 bytes',
        submit: 'Update password',
        submitting: 'Updating…',
        samePassword: 'New password must be different from your old password',
        rateLimited: 'Too many requests. Try again later.',
        serviceError: 'The password cannot be updated right now. Try again later.'
      }
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
