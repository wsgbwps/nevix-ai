import {
  defineResourceTranslations,
  type ResourceOwner
} from '../../../../../shared/i18n/resource-contract'

export const creationTranslations = defineResourceTranslations({
  'zh-CN': {
    creation: {
      sessions: {
        label: '我的创作',
        empty: '还没有创作会话，从一个空白草稿开始',
        unnamed: '未命名创作',
        remove: '删除会话 {{name}}',
        newLabel: '新会话名称（可选）',
        newPlaceholder: '新会话…',
        newSubmit: '创建'
      },
      workspace: {
        label: '工作区',
        empty: '选择或创建一个创作会话开始你的作品',
        generationPending: '图片与视频生成将在此处呈现'
      },
      pile: {
        label: '参考素材牌堆',
        add: '添加参考素材',
        kind: { image: '图', video: '视频', audio: '音' }
      },
      state: {
        loading: '正在读取创作数据…',
        loadFailed: '无法读取创作数据。',
        retry: '重试'
      }
    }
  },
  en: {
    creation: {
      sessions: {
        label: 'My creations',
        empty: 'No creation sessions yet; start from a blank draft',
        unnamed: 'Untitled creation',
        remove: 'Delete session {{name}}',
        newLabel: 'New session name (optional)',
        newPlaceholder: 'New session…',
        newSubmit: 'Create'
      },
      workspace: {
        label: 'Workspace',
        empty: 'Pick or create a session to start your work',
        generationPending: 'Image and video generation will appear here'
      },
      pile: {
        label: 'Reference material pile',
        add: 'Add reference material',
        kind: { image: 'IMG', video: 'VID', audio: 'AUD' }
      },
      state: {
        loading: 'Loading creation data…',
        loadFailed: 'Creation data could not be loaded.',
        retry: 'Retry'
      }
    }
  }
})

export const creationResourceOwner: ResourceOwner = {
  namespace: 'creation',
  resources: creationTranslations
}

export const creationResources = creationTranslations
