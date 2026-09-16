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

test(
  'a creator manages generated assets through the team Asset Library',
  { tag: ['@smoke', '@storage'] },
  async () => {
    test.setTimeout(180_000)
    test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
    if (!identityServer) return

    const identity = uniqueIdentity('asset-library')
    const user = await createStableTeamUser(identityServer, identity, '资产库验收用户')
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-asset-library-'))
    const downloadDir = await mkdtemp(join(tmpdir(), 'nevix-asset-library-download-'))
    const prompt = '秋季上新资产库验收，冷调布光'
    try {
      const launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['zh-CN'],
        serverUrl: identityServer.serverUrl
      })
      try {
        await launched.page.getByLabel('邮箱').fill(identity.email)
        await launched.page.getByLabel('密码').fill(identity.password)
        await launched.page.getByRole('button', { name: '登录', exact: true }).click()
        await expect(
          launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })
        ).toBeVisible()

        const workbench = launched.page.getByTestId('creation-workbench')
        await launched.page.getByRole('link', { name: 'AI 创作' }).click()
        await workbench.getByTestId('session-new').click()
        await workbench.getByTestId('composer-prompt').fill(prompt)
        await workbench.getByTestId('composer-params').click()
        await launched.page
          .getByRole('menu')
          .getByRole('button', { name: '2', exact: true })
          .click()
        await launched.page.keyboard.press('Escape')
        await expect(workbench.getByTestId('composer-submit')).toBeEnabled({ timeout: 15_000 })
        await workbench.getByTestId('composer-submit').click()
        await expect(launched.page.locator('[data-slot-status="succeeded"]')).toHaveCount(2, {
          timeout: 60_000
        })

        await launched.page.getByRole('link', { name: '资产' }).click()
        await expect(launched.page.getByRole('heading', { name: '资产' })).toBeVisible()
        await expect(launched.page.getByLabel('breadcrumb').getByText('资产')).toBeVisible()
        await expect(launched.page.getByTestId('asset-card')).toHaveCount(2)
        await expect(launched.page.getByText('媒体加载失败')).toHaveCount(0)
        await expect(launched.page.getByTestId('asset-card').locator('img')).toHaveCount(2)

        await launched.page.getByLabel('媒体类型').selectOption('image')
        await launched.page.getByLabel('创建者').fill(user.display_name)
        await launched.page.getByLabel('排序').selectOption('oldest')
        await launched.page.getByLabel('搜索').fill(user.display_name)
        await launched.page.getByRole('button', { name: '搜索', exact: true }).click()
        await expect(launched.page.getByTestId('asset-card')).toHaveCount(2)

        const openButtons = launched.page.getByRole('button', { name: /^打开资产 / })
        await openButtons.first().click()
        const dialog = launched.page.getByRole('dialog')
        await expect(dialog).toContainText(prompt)
        await expect(dialog.getByRole('button', { name: '发布（即将开放）' })).toBeDisabled()
        const otherResult = dialog
          .getByRole('button', { name: /^结果 / })
          .and(launched.page.locator('[data-variant="outline"]'))
        const otherResultName = await otherResult.textContent()
        expect(otherResultName).not.toBeNull()
        await otherResult.click()
        await expect(
          dialog.getByRole('button', { name: otherResultName ?? '', exact: true })
        ).toHaveAttribute('data-variant', 'secondary')

        await launched.electronApp.evaluate(({ session }, dir) => {
          session.defaultSession.removeAllListeners('will-download')
          session.defaultSession.on('will-download', (_event, item) => {
            item.setSavePath(`${dir}/asset.png`)
          })
        }, downloadDir)
        await dialog.getByRole('button', { name: '下载', exact: true }).click()
        await expect(dialog.getByRole('status')).toContainText('下载完成')
        const savedPath = join(downloadDir, 'asset.png')
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
        expect(
          readFileSync(savedPath)
            .subarray(0, 8)
            .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        ).toBe(true)

        await dialog.getByRole('button', { name: '做同款' }).click()
        await expect(workbench).toBeVisible()
        await expect(workbench.getByTestId('composer-prompt')).toHaveText(prompt)
        await expect(workbench.getByTestId('composer-params')).toContainText('2')

        await launched.page.getByRole('link', { name: '资产' }).click()
        await expect(launched.page.getByTestId('asset-card')).toHaveCount(2)
        await launched.page
          .getByRole('button', { name: /^打开资产 / })
          .first()
          .click()
        const deleteDialog = launched.page.getByRole('dialog')
        launched.page.once('dialog', (confirmation) => void confirmation.accept())
        await deleteDialog.getByRole('button', { name: '删除', exact: true }).click()
        await expect(deleteDialog).toBeHidden()
        await expect(launched.page.getByTestId('asset-card')).toHaveCount(1)
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
      await rm(downloadDir, { recursive: true, force: true })
    }
  }
)
