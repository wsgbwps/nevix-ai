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

// The shortest Creation tracer (issue #156): sign in, open AI Creation from
// the App Shell, create a private session, and upload one reference image
// through the Go trusted data plane until it lands in the pile.
test(
  'a signed-in creator opens AI Creation, creates a session, and uploads a reference image',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(90_000)
    test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
    if (!identityServer) return

    const identity = uniqueIdentity('creation-tracer')
    await createStableTeamUser(identityServer, identity)
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-creation-tracer-'))

    try {
      const launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['zh-CN'],
        serverUrl: identityServer!.serverUrl
      })
      try {
        await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
        await launched.page.getByLabel('邮箱').fill(identity.email)
        await launched.page.getByLabel('密码').fill(identity.password)
        await launched.page.getByRole('button', { name: '登录', exact: true }).click()
        await expect(
          launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })
        ).toBeVisible()

        // 侧栏进入 AI 创作；空库呈现显式空态，而不是缓存假象。
        await launched.page.getByRole('link', { name: 'AI 创作' }).click()
        const workbench = launched.page.getByTestId('creation-workbench')
        await expect(workbench).toBeVisible()
        await expect(workbench.getByText('还没有创作会话，从一个空白草稿开始')).toBeVisible()

        // 建会话 → 出现在私有列表并进入工作区。
        await workbench.getByLabel('新会话名称（可选）').fill('E2E 会话')
        await workbench.getByLabel('创建').click()
        await expect(workbench.getByRole('button', { name: 'E2E 会话', exact: true })).toBeVisible()
        await expect(workbench.getByText('选择或创建一个创作会话开始你的作品')).toHaveCount(0)

        // 上传一张真实 PNG → 经 Go 流式转存后出现在牌堆。
        const fileChooserPromise = launched.page.waitForEvent('filechooser')
        await workbench.getByLabel('添加参考素材').click()
        const chooser = await fileChooserPromise
        await chooser.setFiles({ name: 'shot.png', mimeType: 'image/png', buffer: REAL_PNG })
        await expect(
          workbench
            .getByTestId('reference-pile')
            .getByRole('listitem', { name: 'shot.png', exact: true })
        ).toBeVisible({ timeout: 15_000 })
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)
