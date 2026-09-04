import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
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

// The shortest image-generation tracer (issue #160): a member signs in,
// submits a text-to-image task through the composer, the worker generates
// against the fake Kapon route, and the verified PNG slot offers a working
// download. Everything upstream of the fake — admission, queue, worker,
// credential decryption, transfer, probe, slot verdict, Media Asset — is the
// real production stack built by the E2E command.
test(
  'a creator generates one image and downloads the verified result',
  { tag: '@image' },
  async () => {
    test.setTimeout(180_000)
    test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
    if (!identityServer) return

    const identity = uniqueIdentity('creation-image')
    await createStableTeamUser(identityServer, identity)
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-creation-image-'))
    const downloadDir = await mkdtemp(join(tmpdir(), 'nevix-creation-download-'))

    try {
      const launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['zh-CN'],
        serverUrl: identityServer.serverUrl
      })
      try {
        await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
        await launched.page.getByLabel('邮箱').fill(identity.email)
        await launched.page.getByLabel('密码').fill(identity.password)
        await launched.page.getByRole('button', { name: '登录', exact: true }).click()
        await expect(
          launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })
        ).toBeVisible()

        const workbench = launched.page.getByTestId('creation-workbench')
        await launched.page.getByRole('link', { name: 'AI 创作' }).click()
        await expect(workbench).toBeVisible()

        // 「新对话」只进入未落库的 composing 态；会话随首次提交物化。
        await workbench.getByTestId('session-new').click()
        await expect(workbench.getByTestId('composer')).toBeVisible()
        await workbench.getByTestId('composer-prompt').fill('秋季上新主图，冷调布光')

        // The verified output's download lands in the test directory: the
        // main-process handler stands in for the OS save dialog.
        await launched.electronApp.evaluate(({ session }, dir) => {
          session.defaultSession.removeAllListeners('will-download')
          session.defaultSession.on('will-download', (_event, item) => {
            item.setSavePath(`${dir}/result.png`)
          })
        }, downloadDir)

        await expect(workbench.getByTestId('composer-submit')).toBeEnabled({ timeout: 15_000 })
        await workbench.getByTestId('composer-submit').click()

        // The worker converges the real queue: the slot's succeeded verdict
        // proves submit → transfer → probe → slot → Media Asset end to end.
        const succeededSlot = launched.page.locator('[data-slot-status="succeeded"]')
        await expect(succeededSlot).toHaveCount(1, { timeout: 60_000 })
        const downloadButton = succeededSlot.getByTestId(/slot-download-/)
        await expect(downloadButton).toBeVisible()
        await downloadButton.click()

        const savedPath = join(downloadDir, 'result.png')
        await expect
          .poll(
            () => {
              try {
                return readFileSync(savedPath).length
              } catch {
                return 0
              }
            },
            { timeout: 30_000 }
          )
          .toBeGreaterThan(0)
        const magic = readFileSync(savedPath).subarray(0, 8)
        expect(magic.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
          true
        )
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
      await rm(downloadDir, { recursive: true, force: true })
    }
  }
)
