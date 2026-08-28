import { defineResourceTranslations, type ResourceOwner } from '../../shared/i18n/resource-contract'

export const windowTranslations = defineResourceTranslations({
  'zh-CN': {
    title: 'Nevix AI — 桌面端',
    nativeEditing: {
      editMenu: '编辑',
      undo: '撤销',
      cut: '剪切',
      copy: '复制',
      paste: '粘贴',
      delete: '删除',
      selectAll: '全选'
    }
  },
  en: {
    title: 'Nevix AI — Desktop',
    nativeEditing: {
      editMenu: 'Edit',
      undo: 'Undo',
      cut: 'Cut',
      copy: 'Copy',
      paste: 'Paste',
      delete: 'Delete',
      selectAll: 'Select All'
    }
  }
})

export const windowResources = {
  'zh-CN': { window: windowTranslations['zh-CN'] },
  en: { window: windowTranslations.en }
} as const

export const windowResourceOwner: ResourceOwner = {
  namespace: 'window',
  resources: windowTranslations
}
