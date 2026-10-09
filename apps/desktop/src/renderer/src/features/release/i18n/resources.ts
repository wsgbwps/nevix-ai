import {
  defineResourceTranslations,
  type ResourceOwner
} from '../../../../../shared/i18n/resource-contract'

const translations = defineResourceTranslations({
  'zh-CN': {
    title: '服务器更新',
    description: '由客户运维者安装更新。检查更新不会改变当前运行实例。',
    current: '当前服务器版本',
    currentMinimum: '当前所需最低桌面版本',
    candidate: '候选服务器版本',
    minimumServer: '升级所需最低来源服务器版本',
    minimumDesktop: '候选所需最低桌面版本',
    check: '立即检查',
    checking: '正在检查…',
    unavailable: '无法读取更新状态。请确认当前连接和管理员会话后重试。',
    outcomes: {
      'not-checked': '尚未检查更新。',
      'trust-unconfigured': '正式发行的签名公钥尚未配置，暂不能信任更新。',
      'unknown-version': '当前服务器不是已知正式版本，暂不能判断升级兼容性。',
      current: '当前没有更新的服务器版本。',
      available: '有可用的服务器更新。请联系运维者安排维护升级。',
      incompatible: '候选更新不支持从当前服务器直接升级。请联系运维者确认升级路径。',
      'network-failure': '无法连接官方更新源。当前业务继续运行，请稍后重试。',
      'invalid-release': '官方更新清单未通过签名或格式验证，已拒绝该更新。'
    }
  },
  en: {
    title: 'Server updates',
    description: 'Your operator installs updates. Checking does not change the running instance.',
    current: 'Current Server version',
    currentMinimum: 'Current minimum Desktop version',
    candidate: 'Candidate Server version',
    minimumServer: 'Minimum source Server version for upgrade',
    minimumDesktop: 'Candidate minimum Desktop version',
    check: 'Check now',
    checking: 'Checking…',
    unavailable:
      'Could not read update status. Check your connection and Admin session, then retry.',
    outcomes: {
      'not-checked': 'Updates have not been checked yet.',
      'trust-unconfigured':
        'The production signing public key is not configured; updates cannot be trusted yet.',
      'unknown-version':
        'The running Server is not a known release; upgrade compatibility cannot be determined.',
      current: 'No newer Server release is available.',
      available:
        'A Server update is available. Ask your operator to schedule a maintenance upgrade.',
      incompatible:
        'The candidate does not support upgrading directly from this Server. Ask your operator to confirm the upgrade path.',
      'network-failure':
        'Could not reach the official update source. Business continues; try again later.',
      'invalid-release':
        'The official manifest failed signature or format verification; this update was rejected.'
    }
  }
})
export const releaseResources = {
  'zh-CN': { release: translations['zh-CN'] },
  en: { release: translations.en }
} as const
export const releaseResourceOwner: ResourceOwner = { namespace: 'release', resources: translations }
