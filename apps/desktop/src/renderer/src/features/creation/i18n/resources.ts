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
        newSubmit: '创建',
        private: 'Creation Session 由创建者私有',
        meta: {
          justNow: '刚刚',
          minutesAgo: '{{n}} 分钟前',
          hoursAgo: '{{n}} 小时前',
          daysAgo: '{{n}} 天前'
        }
      },
      workspace: {
        label: '工作区',
        empty: '选择或创建一个创作会话开始你的作品',
        generationPending: '图片与视频生成将在此处呈现',
        heroTitle: '你好，想创作什么？',
        heroSubtitle: '从描述开始，或选一个创作起点',
        templateTry: '试一试',
        templates: {
          scene: {
            title: '商品场景合成',
            detail: '将商品自然放入真实使用场景',
            prompt: '将商品放入干净明亮的生活方式场景，突出真实材质与核心卖点。'
          },
          series: {
            title: '系列主图变体',
            detail: '统一风格，快速探索多种构图',
            prompt: '围绕同一商品生成一组视觉统一、构图不同的主图。'
          },
          videoAd: {
            title: '短视频广告创意',
            detail: '用清晰节奏展示商品使用价值',
            prompt: '为商品制作一支节奏明快的短视频广告，包含开场钩子、卖点展示和结尾定格。'
          }
        }
      },
      composer: {
        label: '创作输入',
        promptLabel: '提示词',
        promptPlaceholder: '描述你想生成的画面或视频…',
        promptPlaceholderWithRefs: '描述如何使用这些参考素材…',
        submit: '生成',
        submitPending: '生成提交将在后续版本开放，草稿会自动保存。',
        media: { label: '媒体', image: '图片生成', video: '视频生成' },
        model: { label: '模型' },
        mode: {
          label: '模式',
          'text-to-image': '文生图片',
          'reference-image': '参考图片',
          'text-to-video': '文生视频',
          'first-frame': '首帧',
          'first-last-frame': '首尾帧',
          'omni-reference': '全能参考'
        },
        params: {
          label: '参数',
          ratio: '比例',
          resolution: '分辨率',
          quantity: '数量',
          duration: '时长',
          seconds: '{{n}} 秒'
        },
        stale: {
          badge: '能力已变化',
          note: '当前能力清单已不含该值；原值已保留，提交前需要更换。',
          references: '当前模式下的参考素材数量或类型已超出能力清单；已原样保留，提交前需要调整。'
        },
        manifestUnavailable: '能力清单暂时不可用；草稿仍可编辑并自动保存。',
        unavailable: {
          template: '当前没有可用的生成能力：{{reason}}，{{action}}',
          reasons: {
            production_readiness_pending: '能力尚未通过发布验收',
            not_configured: '尚未配置 AI 供应商连接',
            checking: '正在检查连接',
            credential_invalid: '供应商拒绝了当前密钥',
            credential_unavailable: '供应商密钥暂不可用',
            connection_paused: '连接已暂停',
            model_unavailable: '供应商模型暂不可用'
          },
          actions: {
            wait: '请稍候再试。',
            await_release: '等待版本发布后即可使用。',
            contact_admin: '请联系管理员处理。'
          }
        },
        save: {
          saving: '草稿保存中…',
          saved: '草稿已保存',
          failed: '草稿保存失败，点击重试'
        },
        deck: {
          label: '参考素材牌堆',
          add: '添加参考素材',
          remove: '移除 {{name}}',
          kind: { image: '图', video: '视频', audio: '音' }
        }
      },
      state: {
        loading: '正在读取创作数据…',
        loadFailed: '无法读取创作数据。',
        retry: '重试'
      },
      provider: {
        title: 'AI 创作能力',
        description:
          '配置团队唯一的 Kapon 图像与视频生成连接。密钥加密保存在服务器，任何人都无法取回已保存的密钥。',
        empty: '尚未配置 AI 供应商连接，配置后团队成员即可生成图片与视频。',
        configure: '配置连接',
        replace: '替换密钥',
        recheck: '立即重检',
        pause: '暂停',
        resume: '恢复',
        delete: '删除连接',
        adminState: { enabled: '已启用', paused: '已暂停' },
        credential: {
          checking: '检查中',
          valid: '有效',
          invalid: '无效',
          credential_unavailable: '密钥不可用'
        },
        media: { checking: '检查中', available: '可用', unavailable: '不可用' },
        fields: { credential: '供应商凭据', image: '图片生成', video: '视频生成' },
        attention: {
          credentialUnavailable:
            '服务器无法解密已保存的密钥（主密钥丢失或损坏）。重新输入 Kapon 密钥即可恢复，恢复前连接保持关闭。',
          credentialInvalid: 'Kapon 已拒绝当前密钥。请更换新密钥后重试。',
          generic: '连接需要处理：凭据、暂停状态或媒体能力存在异常。'
        },
        member: {
          unavailable: '暂时无法读取创作能力状态。',
          wait: '正在检查，请稍候。',
          contactAdmin: '请联系管理员处理。'
        },
        state: {
          loading: '正在读取连接状态…',
          loadFailed: '无法读取 AI 创作能力状态。',
          retry: '重试'
        },
        dialog: {
          createTitle: '配置 AI 供应商连接',
          replaceTitle: '替换供应商密钥',
          description:
            '输入 Kapon 模型调用密钥。提交前需要重新确认你的管理员密码；密钥仅在验证与加密期间短暂存在于服务器内存。',
          keyLabel: 'Kapon 密钥',
          cancel: '取消',
          submit: '验证并保存',
          submitting: '正在验证…'
        },
        deleteDialog: {
          title: '删除 AI 供应商连接？',
          description:
            '删除将清除已保存的密钥并停止新的生成任务，此操作需要重新确认管理员密码且不可撤销。',
          cancel: '取消',
          confirm: '确认删除'
        },
        errors: {
          networkFailure: '网络错误，请稍后重试。',
          unauthorized: '登录已过期，请重新登录后再试。',
          forbidden: '需要管理员权限。',
          codeFallback: '操作失败（{{code}}）。',
          codes: {
            invalid_request: '请求不合法，请检查输入。',
            secure_transport_required: '该操作要求已确认的 HTTPS 连接，请通过正式部署地址访问。',
            reauth_proof_invalid: '身份确认无效，请重新验证密码。',
            reauth_proof_expired: '身份确认已过期，请重新验证密码。',
            reauth_proof_action_mismatch: '身份确认与该操作不匹配，请重新验证。',
            reauth_proof_already_consumed: '身份确认已被使用，请重新验证密码。',
            provider_connection_exists: '已存在启用的连接，无需重复配置。',
            provider_connection_not_configured: '尚未配置连接。',
            provider_credential_invalid: 'Kapon 拒绝了这个密钥，未做任何更改；请核对后重试。',
            provider_check_temporarily_unavailable: '供应商暂时不可用，稍后重试即可。',
            internal_error: '服务器内部错误，请稍后重试。'
          }
        }
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
        newSubmit: 'Create',
        private: 'Creation Sessions are private to their creator',
        meta: {
          justNow: 'just now',
          minutesAgo: '{{n}} min ago',
          hoursAgo: '{{n}} h ago',
          daysAgo: '{{n}} d ago'
        }
      },
      workspace: {
        label: 'Workspace',
        empty: 'Pick or create a session to start your work',
        generationPending: 'Image and video generation will appear here',
        heroTitle: 'Hello — what will you create?',
        heroSubtitle: 'Start from a description, or pick a starting point',
        templateTry: 'Try it',
        templates: {
          scene: {
            title: 'Product scene composite',
            detail: 'Place a product naturally into a real usage scene',
            prompt:
              'Place the product into a clean, bright lifestyle scene that highlights its real materials and key selling points.'
          },
          series: {
            title: 'Listing image variants',
            detail: 'One style, many compositions to explore quickly',
            prompt:
              'Generate a set of visually unified listing images with different compositions around the same product.'
          },
          videoAd: {
            title: 'Short video ad concept',
            detail: 'Show the product value with a clear rhythm',
            prompt:
              'Create a brisk short-video ad for the product with an opening hook, a selling-point showcase, and a closing freeze frame.'
          }
        }
      },
      composer: {
        label: 'Creation input',
        promptLabel: 'Prompt',
        promptPlaceholder: 'Describe the image or video you want to generate…',
        promptPlaceholderWithRefs: 'Describe how to use these reference materials…',
        submit: 'Generate',
        submitPending: 'Generation submission arrives in a later release; the draft autosaves.',
        media: { label: 'Media', image: 'Image generation', video: 'Video generation' },
        model: { label: 'Model' },
        mode: {
          label: 'Mode',
          'text-to-image': 'Text to image',
          'reference-image': 'Reference image',
          'text-to-video': 'Text to video',
          'first-frame': 'First frame',
          'first-last-frame': 'First & last frame',
          'omni-reference': 'Omni reference'
        },
        params: {
          label: 'Parameters',
          ratio: 'Ratio',
          resolution: 'Resolution',
          quantity: 'Quantity',
          duration: 'Duration',
          seconds: '{{n}}s'
        },
        stale: {
          badge: 'Capability changed',
          note: 'The current capability manifest no longer includes this value; it is preserved until you replace it before submission.',
          references:
            'The reference count or kinds under the current mode exceed the capability manifest; they are preserved until you adjust before submission.'
        },
        manifestUnavailable:
          'The capability manifest is unavailable right now; drafting and autosave keep working.',
        unavailable: {
          template: 'No generation capability is available right now: {{reason}}. {{action}}',
          reasons: {
            production_readiness_pending: 'the capability has not passed release acceptance yet',
            not_configured: 'no AI provider connection is configured',
            checking: 'the connection is being checked',
            credential_invalid: 'the provider rejected the current key',
            credential_unavailable: 'the provider key is temporarily unavailable',
            connection_paused: 'the connection is paused',
            model_unavailable: 'the provider model is temporarily unavailable'
          },
          actions: {
            wait: 'Please wait and try again later.',
            await_release: 'It becomes usable after the next release.',
            contact_admin: 'Please contact your administrator.'
          }
        },
        save: {
          saving: 'Saving draft…',
          saved: 'Draft saved',
          failed: 'Draft save failed; click to retry'
        },
        deck: {
          label: 'Reference material deck',
          add: 'Add reference material',
          remove: 'Remove {{name}}',
          kind: { image: 'IMG', video: 'VID', audio: 'AUD' }
        }
      },
      state: {
        loading: 'Loading creation data…',
        loadFailed: 'Creation data could not be loaded.',
        retry: 'Retry'
      },
      provider: {
        title: 'AI creation capability',
        description:
          "Configure the team's single Kapon connection for image and video generation. Keys are encrypted on the server; a saved key can never be retrieved.",
        empty:
          'No AI provider connection is configured yet; configure one so the team can generate images and video.',
        configure: 'Configure connection',
        replace: 'Replace key',
        recheck: 'Recheck now',
        pause: 'Pause',
        resume: 'Resume',
        delete: 'Delete connection',
        adminState: { enabled: 'Enabled', paused: 'Paused' },
        credential: {
          checking: 'Checking',
          valid: 'Valid',
          invalid: 'Invalid',
          credential_unavailable: 'Key unavailable'
        },
        media: { checking: 'Checking', available: 'Available', unavailable: 'Unavailable' },
        fields: {
          credential: 'Provider credential',
          image: 'Image generation',
          video: 'Video generation'
        },
        attention: {
          credentialUnavailable:
            'The server cannot decrypt the saved key (master key lost or damaged). Re-entering the Kapon key recovers the connection; it stays closed until then.',
          credentialInvalid: 'Kapon rejected the current key. Replace it with a new one.',
          generic:
            'The connection needs attention: credential, pause state, or a media capability is unhealthy.'
        },
        member: {
          unavailable: 'Creation capability status is unavailable right now.',
          wait: 'Checking, please wait.',
          contactAdmin: 'Please contact your administrator.'
        },
        state: {
          loading: 'Loading connection status…',
          loadFailed: 'AI creation capability status could not be loaded.',
          retry: 'Retry'
        },
        dialog: {
          createTitle: 'Configure AI provider connection',
          replaceTitle: 'Replace provider key',
          description:
            'Enter the Kapon model-calling key. You will re-confirm your admin password before submitting; the key exists in server memory only during verification and encryption.',
          keyLabel: 'Kapon key',
          cancel: 'Cancel',
          submit: 'Verify and save',
          submitting: 'Verifying…'
        },
        deleteDialog: {
          title: 'Delete the AI provider connection?',
          description:
            'Deleting clears the saved key and stops new generation tasks. It requires re-confirming your admin password and cannot be undone.',
          cancel: 'Cancel',
          confirm: 'Delete connection'
        },
        errors: {
          networkFailure: 'A network error occurred; try again shortly.',
          unauthorized: 'Your session expired; sign in again and retry.',
          forbidden: 'Administrator role required.',
          codeFallback: 'The command failed ({{code}}).',
          codes: {
            invalid_request: 'The request is invalid; check the input.',
            secure_transport_required:
              'This command requires a proven HTTPS connection; use the official deployment address.',
            reauth_proof_invalid: 'The confirmation is invalid; verify your password again.',
            reauth_proof_expired: 'The confirmation expired; verify your password again.',
            reauth_proof_action_mismatch:
              'The confirmation authorizes a different action; verify again.',
            reauth_proof_already_consumed:
              'The confirmation was already used; verify your password again.',
            provider_connection_exists: 'An enabled connection already exists.',
            provider_connection_not_configured: 'No connection is configured yet.',
            provider_credential_invalid:
              'Kapon rejected this key; nothing was changed. Check it and retry.',
            provider_check_temporarily_unavailable:
              'The provider is temporarily unavailable; retry shortly.',
            internal_error: 'A server error occurred; try again later.'
          }
        }
      }
    }
  }
})

export const creationResourceOwner: ResourceOwner = {
  namespace: 'creation',
  resources: creationTranslations
}

export const creationResources = creationTranslations
