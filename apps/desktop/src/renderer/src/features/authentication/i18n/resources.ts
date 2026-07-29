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
      invalidCredentials: '邮箱或密码错误',
      serviceError: '暂时无法登录，请稍后重试。'
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
      invalidCredentials: 'Email or password is incorrect',
      serviceError: 'Sign-in is temporarily unavailable. Try again later.'
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
