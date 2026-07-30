import {
  defineResourceTranslations,
  type ResourceOwner
} from '../../../../../shared/i18n/resource-contract'

export const authenticationTranslations = defineResourceTranslations({
  'zh-CN': {
    configurationError: {
      heading: '认证暂不可用',
      description: '此构建缺少有效的 Supabase 公开配置。'
    },
    restoring: {
      heading: '正在初始化认证',
      description: '确认登录状态前不会显示应用内容。'
    },
    login: {
      heading: '登录 Nevix AI',
      description: '使用已验证的邮箱继续。',
      email: '邮箱',
      password: '密码',
      submit: '登录',
      submitting: '正在登录…',
      noAccount: '还没有账号？',
      createAccount: '创建账号',
      invalidCredentials: '邮箱或密码错误',
      rateLimited: '请求过于频繁，请稍后重试。',
      serviceError: '暂时无法登录，请稍后重试。'
    },
    signup: {
      heading: '创建你的 Nevix AI 账号',
      description: '只需邮箱和密码，无需填写个人资料或组织信息。',
      passwordBytes: '{{count}} / 12–72 UTF-8 字节',
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
    logout: {
      submit: '退出当前设备',
      submitting: '正在退出…'
    }
  },
  en: {
    configurationError: {
      heading: 'Authentication is unavailable',
      description: 'This build is missing valid public Supabase configuration.'
    },
    restoring: {
      heading: 'Initializing authentication',
      description: 'Application content stays hidden until your session is checked.'
    },
    login: {
      heading: 'Sign in to Nevix AI',
      description: 'Continue with your verified email address.',
      email: 'Email',
      password: 'Password',
      submit: 'Sign in',
      submitting: 'Signing in…',
      noAccount: 'New to Nevix AI?',
      createAccount: 'Create account',
      invalidCredentials: 'Email or password is incorrect',
      rateLimited: 'Too many requests. Try again later.',
      serviceError: 'Sign-in is temporarily unavailable. Try again later.'
    },
    signup: {
      heading: 'Create your Nevix AI account',
      description: 'Use only your email and password. No profile or organization is required.',
      passwordBytes: '{{count}} of 12–72 UTF-8 bytes',
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
    logout: {
      submit: 'Sign out of this device',
      submitting: 'Signing out…'
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
