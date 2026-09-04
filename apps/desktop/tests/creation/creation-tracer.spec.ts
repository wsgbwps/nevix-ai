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

// A real, decodable 256x256 PNG: the Go server fully decodes every upload
// before accepting it (issue #156) and enforces the manifest's reference
// dimension envelope (issue #160), so fabricated or undersized bytes would
// be rejected on arrival.
const REAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAACYUlEQVR42u3UMQEAAAQAQfHEFFEDCmjghivww0dWD/BTiAAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAYABiAAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAYABiAAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAYABCAEGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAYABAAYAGABgAIABAAYAGABgAIABAAYAGABgAIABAAYAGABgAIABAAYAGABgAIABAAYAGABgAIABAAYAGABgAIABAAYAGABgAIABAAYAGABgAIABgAEABgAYAGAAgAEABgAYAGAAgAEABgAYAGAAgAEABgAYAGAAgAEABgAYAGAAgAEABgAYAGAAgAEABgAYAGAAgAEABgAYAGAAgAEABgAYAGAAgAGAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQAGABgAYACAAQCXBbq7Kpo57ns0AAAAAElFTkSuQmCC',
  'base64'
)

// The shortest Creation tracer (issues #156 / #177, ADR-0017): sign in, open
// AI Creation from the App Shell, draft in a composing session that does not
// exist yet (the 「新对话」 row creates nothing server-side), hold one
// reference image locally, then submit — the first submission materializes
// the private session, uploads the reference through the Go trusted data
// plane, and carries the full generation intent in the submit request. The
// editable draft itself is device-local state: a restart recovers the prompt
// from this device's store (never the server) and the reference from the
// server-side material it became at submission.
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

    const signIn = async (app: LaunchedApp): Promise<void> => {
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

        // 「新对话」只进入未落库的 composing 态，提示词可以先编辑。
        await workbench.getByTestId('session-new').click()
        await expect(workbench.getByTestId('composer')).toBeVisible()
        await workbench.getByTestId('composer-prompt').fill('秋季上新主图，冷调布光')

        // 上传一张真实 PNG：composing 态先持有在本地，提交时才经 Go 流式转存。
        const fileChooserPromise = launched.page.waitForEvent('filechooser')
        await workbench.getByLabel('添加参考素材').click()
        const chooser = await fileChooserPromise
        await chooser.setFiles({ name: 'shot.png', mimeType: 'image/png', buffer: REAL_PNG })
        await expect(
          workbench
            .getByTestId('reference-deck')
            .getByRole('button', { name: 'shot.png', exact: true })
        ).toBeVisible({ timeout: 15_000 })

        // 首次提交：会话此刻才创建，素材随之上传，提交请求携带完整生成意图。
        await expect(workbench.getByTestId('composer-submit')).toBeEnabled({ timeout: 15_000 })
        await workbench.getByTestId('composer-submit').click()
        await expect(workbench.getByTestId('result-gallery')).toBeVisible({ timeout: 15_000 })

        await launched.electronApp.close()

        // 重启：提示词从本设备的草稿存储恢复（ADR-0017），参考图从提交时
        // 落库的服务端素材恢复。
        const relaunched = await launchTestApp({ userDataDir, systemLanguages: ['zh-CN'] })
        try {
          const login = relaunched.page.getByRole('heading', { name: '登录 Nevix AI' })
          const toCreation = relaunched.page.getByRole('link', { name: 'AI 创作' })
          // The renderer mounts its restored surface asynchronously; an instant
          // isVisible() raced the boot and skipped a needed re-sign-in.
          await login.or(toCreation).first().waitFor({ state: 'visible', timeout: 15_000 })
          if (await login.isVisible()) await signIn(relaunched)
          await toCreation.click()
          const restored = relaunched.page.getByTestId('creation-workbench')
          // 首次提交物化的会话未命名，列表以「未命名创作」呈现。
          await restored.getByRole('button', { name: '未命名创作', exact: true }).click()
          await expect(restored.getByTestId('composer')).toBeVisible()
          // Lexical 编辑器是 contenteditable combobox，断言走文本内容而非 value。
          await expect(restored.getByTestId('composer-prompt')).toHaveText(
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
