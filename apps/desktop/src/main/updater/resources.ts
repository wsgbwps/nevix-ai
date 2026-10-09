import { defineResourceTranslations } from '../../shared/i18n/resource-contract'
export const updateTranslations = defineResourceTranslations({
  'zh-CN': {
    menu: '检查更新…',
    title: 'Nevix AI 更新',
    current: '当前已是最新版本。',
    available: '发现可用更新 {{version}}。',
    serverUpgrade: '请先联系管理员升级 Server，最低版本 {{minimum}}。',
    desktopUpgrade: '当前 Desktop 低于此实例要求，请升级至 {{minimum}} 或更新版本。',
    unavailable: '无法确认当前 Server 的运行版本，更新已暂缓。请检查服务器连接。',
    failed: '检查更新失败。请稍后重试，当前应用可以继续使用。',
    trust: '发行信任尚未配置，无法验证官方更新。',
    ready: '更新 {{version}} 已下载，可以安装。',
    installDetail: '安装前将完成当前窗口的退出准备，然后重启应用。',
    install: '安装并重启',
    later: '稍后',
    ok: '确定'
  },
  en: {
    menu: 'Check for Updates…',
    title: 'Nevix AI Updates',
    current: 'You are up to date.',
    available: 'Update {{version}} is available.',
    serverUpgrade: 'Ask your administrator to upgrade Server to {{minimum}} or newer first.',
    desktopUpgrade: 'This instance requires Desktop {{minimum}} or newer. Please upgrade Desktop.',
    unavailable:
      'The running Server version could not be verified. Update deferred. Check your server connection.',
    failed: 'Update check failed. Try again later; the current app remains available.',
    trust: 'Release trust is not configured. Official updates cannot be verified.',
    ready: 'Update {{version}} is downloaded and ready to install.',
    installDetail: 'Complete the current window’s exit preparation, then restart the app.',
    install: 'Install and Restart',
    later: 'Later',
    ok: 'OK'
  }
})
