import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'
import {
  createStableTeamUser,
  readIdentityServerConfig,
  uniqueIdentity
} from '../auth/helpers/identity-server'

const identityServer = readIdentityServerConfig()

// A real, decodable 1x1 PNG: the Go server fully decodes every upload before
// accepting it (issue #156), so fabricated bytes would be rejected on arrival.
const REAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

// The shortest Creation tracer (issues #156 / #177): sign in, open AI
// Creation from the App Shell, create a private session, type a draft that
// autosaves, upload one reference image through the Go trusted data plane,
// then restart the app and recover the saved draft from the server.
test(
  'a creator drafts in the Workbench and the draft survives an app restart',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(150_000)
    test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
    if (!identityServer) return

    const identity = uniqueIdentity('creation-tracer')
    await createStableTeamUser(identityServer, identity)
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-creation-tracer-'))

    type LaunchedApp = Awaited<ReturnType<typeof launchTestApp>>

    const signIn = async (app: LaunchedApp) => {
      await expect(app.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      await app.page.getByLabel('邮箱').fill(identity.email)
      await app.page.getByLabel('密码').fill(identity.password)
      await app.page.getByRole('button', { name: '登录', exact: true }).click()
      await expect(app.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()
    }

    try {
      const launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['zh-CN'],
        serverUrl: identityServer!.serverUrl
      })
      try {
        await signIn(launched)

        // 侧栏进入 AI 创作；空库呈现显式空态，而不是缓存假象。
        await launched.page.getByRole('link', { name: 'AI 创作' }).click()
        const workbench = launched.page.getByTestId('creation-workbench')
        await expect(workbench).toBeVisible()
        await expect(workbench.getByText('还没有创作会话，从一个空白草稿开始')).toBeVisible()

        // 建会话 → 底部 Composer 出现，提示词可以编辑。
        await workbench.getByLabel('新会话名称（可选）').fill('E2E 会话')
        await workbench.getByLabel('创建').click()
        await expect(workbench.getByTestId('composer')).toBeVisible()
        await workbench.getByTestId('composer-prompt').fill('秋季上新主图，冷调布光')
        await expect(workbench.getByTestId('composer-save')).toContainText('草稿已保存', {
          timeout: 15_000
        })

        // 上传一张真实 PNG → 经 Go 流式转存后折叠进 Composer 内的参考牌堆。
        const fileChooserPromise = launched.page.waitForEvent('filechooser')
        await workbench.getByLabel('添加参考素材').click()
        const chooser = await fileChooserPromise
        await chooser.setFiles({ name: 'shot.png', mimeType: 'image/png', buffer: REAL_PNG })
        await expect(
          workbench
            .getByTestId('reference-deck')
            .getByRole('button', { name: 'shot.png', exact: true })
        ).toBeVisible({ timeout: 15_000 })
        // 素材入牌堆同样触发一次草稿保存，重启用的是服务端权威草稿。
        await expect(workbench.getByTestId('composer-save')).toContainText('草稿已保存', {
          timeout: 15_000
        })

        await launched.electronApp.close()

        // 重启：草稿经 Go API 从服务端恢复，而不是本地缓存。
        const relaunched = await launchTestApp({ userDataDir, systemLanguages: ['zh-CN'] })
        try {
          const loginVisible = await relaunched.page
            .getByRole('heading', { name: '登录 Nevix AI' })
            .isVisible()
          if (loginVisible) await signIn(relaunched)
          await relaunched.page.getByRole('link', { name: 'AI 创作' }).click()
          const restored = relaunched.page.getByTestId('creation-workbench')
          await restored.getByRole('button', { name: 'E2E 会话', exact: true }).click()
          await expect(restored.getByTestId('composer')).toBeVisible()
          await expect(restored.getByTestId('composer-prompt')).toHaveValue(
            '秋季上新主图，冷调布光',
            { timeout: 15_000 }
          )
          await expect(
            restored
              .getByTestId('reference-deck')
              .getByRole('button', { name: 'shot.png', exact: true })
          ).toBeVisible()
        } finally {
          await relaunched.electronApp.close()
        }
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)
