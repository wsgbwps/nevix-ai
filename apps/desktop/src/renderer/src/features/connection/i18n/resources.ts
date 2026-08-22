import {
  defineResourceTranslations,
  type ResourceOwner
} from '../../../../../shared/i18n/resource-contract'

export const connectionTranslations = defineResourceTranslations({
  'zh-CN': {
    screen: {
      heading: '连接到你的 Nevix 服务器',
      description: '输入部署实例的服务器地址，先测试连通再保存。',
      urlLabel: '服务器地址',
      test: '测试连接',
      testing: '正在测试…',
      save: '保存并继续',
      saving: '正在保存…'
    },
    probe: {
      reachable: '连接成功。',
      invalidUrl: '地址无效：公网地址必须使用 https；内网地址可以使用 http。',
      unreachable: '无法连接服务器，请检查地址与网络后重试。'
    },
    certificate: {
      confirmTitle: '服务器证书不受信任',
      confirmDescription:
        '该服务器出示的证书未通过标准验证（例如自签名证书）。请与服务器管理员核对下方指纹后，再选择信任。首次确认后本设备会记住该指纹。',
      changedTitle: '服务器证书指纹已变更',
      changedDescription:
        '该服务器的证书指纹与此前在本设备确认的指纹不一致，可能是服务器换发了证书，也可能是连接被劫持。请与管理员核对新指纹后再决定是否信任。',
      subject: '颁发给',
      issuer: '颁发者',
      validTo: '有效期至',
      fingerprint: '证书指纹（SHA-256）',
      trust: '信任此指纹',
      trusting: '正在记录…'
    },
    settings: {
      currentUrl: '当前服务器地址',
      savedNotice: '已保存。正在重新连接…'
    },
    theme: {
      switchToLight: '切换到浅色主题',
      switchToDark: '切换到深色主题'
    }
  },
  en: {
    screen: {
      heading: 'Connect to your Nevix server',
      description: 'Enter your deployment server address, test it, then save.',
      urlLabel: 'Server address',
      test: 'Test connection',
      testing: 'Testing…',
      save: 'Save and continue',
      saving: 'Saving…'
    },
    probe: {
      reachable: 'Connection succeeded.',
      invalidUrl:
        'Invalid address: public addresses require https; intranet addresses may use http.',
      unreachable: 'Could not reach the server. Check the address and network, then retry.'
    },
    certificate: {
      confirmTitle: 'Server certificate is not trusted',
      confirmDescription:
        'The server presented a certificate that failed standard verification (for example, a self-signed one). Verify the fingerprint below with your server administrator before trusting it. This device remembers the fingerprint after the first confirmation.',
      changedTitle: 'Server certificate fingerprint changed',
      changedDescription:
        "The server's certificate fingerprint differs from the one confirmed on this device earlier. The server may have replaced its certificate, or the connection may be intercepted. Verify the new fingerprint with your administrator before trusting it.",
      subject: 'Issued to',
      issuer: 'Issuer',
      validTo: 'Valid until',
      fingerprint: 'Certificate fingerprint (SHA-256)',
      trust: 'Trust this fingerprint',
      trusting: 'Recording…'
    },
    settings: {
      currentUrl: 'Current server address',
      savedNotice: 'Saved. Reconnecting…'
    },
    theme: {
      switchToLight: 'Switch to light theme',
      switchToDark: 'Switch to dark theme'
    }
  }
})

export const connectionResources = {
  'zh-CN': { connection: connectionTranslations['zh-CN'] },
  en: { connection: connectionTranslations.en }
} as const

export const connectionResourceOwner: ResourceOwner = {
  namespace: 'connection',
  resources: connectionTranslations
}
