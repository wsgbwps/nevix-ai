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

function percentile95(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY
}

test(
  'a creator manages generated assets through the team Asset Library',
  { tag: ['@smoke', '@storage'] },
  async () => {
    test.setTimeout(180_000)
    test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
    if (!identityServer) return

    const identity = uniqueIdentity('asset-library')
    await createStableTeamUser(identityServer, identity, '资产库验收用户')
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-asset-library-'))
    const adminUserDataDir = await mkdtemp(join(tmpdir(), 'nevix-asset-library-admin-'))
    const downloadDir = await mkdtemp(join(tmpdir(), 'nevix-asset-library-download-'))
    const prompt = '秋季上新资产库验收，冷调布光'
    const signIn = async (
      app: Awaited<ReturnType<typeof launchTestApp>>,
      email: string,
      password: string
    ): Promise<void> => {
      await app.page.getByLabel('邮箱').fill(email)
      await app.page.getByLabel('密码').fill(password)
      await app.page.getByRole('button', { name: '登录', exact: true }).click()
      await expect(app.page.getByRole('heading', { name: '灵感' })).toBeVisible()
    }
    try {
      const launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['zh-CN'],
        serverUrl: identityServer.serverUrl
      })
      try {
        await signIn(launched, identity.email, identity.password)

        const workbench = launched.page.getByTestId('creation-workbench')
        await launched.page.getByTestId('session-new').click()
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
        await expect(launched.page.getByTestId('asset-card')).toHaveCount(2)
        // The E2E storage fake has no bucket to issue display URLs from.
        await expect(launched.page.getByText('媒体加载失败')).toHaveCount(2)

        await launched.page
          .getByRole('group', { name: '媒体类型' })
          .getByRole('button', { name: '图片' })
          .click()
        await launched.page.getByRole('button', { name: '排序' }).click()
        await launched.page.getByRole('menuitemradio', { name: '远-近' }).click()
        await expect(launched.page.getByTestId('asset-card')).toHaveCount(2)

        const openButtons = launched.page.getByRole('button', { name: /^打开资产 / })
        const publishedAssetName = await openButtons.first().getAttribute('aria-label')
        expect(publishedAssetName).not.toBeNull()
        await openButtons.first().click()
        const dialog = launched.page.getByRole('dialog')
        await expect(dialog).toContainText(prompt)
        launched.page.once('dialog', (confirmation) => void confirmation.accept())
        await dialog.getByRole('button', { name: '发布到灵感' }).click()
        await expect(dialog.getByRole('button', { name: '撤回发布' })).toBeVisible()

        const admin = await launchTestApp({
          userDataDir: adminUserDataDir,
          systemLanguages: ['zh-CN'],
          serverUrl: identityServer.serverUrl
        })
        try {
          await signIn(admin, identityServer.adminEmail, identityServer.adminPassword)
          await expect(admin.page.getByTestId('inspiration-card')).toHaveCount(2)
          await expect(admin.page.getByText('已发布', { exact: true })).toHaveCount(1)
          await expect(admin.page.getByText('未发布', { exact: true })).toHaveCount(1)
          await admin.page
            .getByRole('button', { name: /^打开灵感 / })
            .first()
            .click()
          await expect(admin.page.getByRole('dialog')).toContainText(prompt)
        } finally {
          await admin.electronApp.close()
        }

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
        await expect(dialog.getByRole('status').filter({ hasText: '下载完成' })).toBeVisible()
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

        await launched.page.keyboard.press('Escape')
        await launched.page.getByRole('link', { name: '灵感' }).click()
        await expect(launched.page.getByTestId('inspiration-card')).toHaveCount(1)
        await launched.page.getByRole('button', { name: /^打开灵感 / }).click()
        const inspirationDialog = launched.page.getByRole('dialog')
        await expect(inspirationDialog).toContainText(prompt)
        await inspirationDialog.getByRole('button', { name: '做同款' }).click()
        await expect(workbench).toBeVisible()
        await expect(workbench.getByTestId('composer-prompt')).toHaveText(prompt)
        await expect(workbench.getByTestId('composer-params')).toContainText('2')

        await launched.electronApp.close()
        const relaunched = await launchTestApp({ userDataDir, systemLanguages: ['zh-CN'] })
        try {
          const login = relaunched.page.getByRole('heading', { name: '登录 Nevix AI' })
          const restoredSession = relaunched.page
            .getByRole('button', { name: '未命名创作', exact: true })
            .first()
          await login.or(restoredSession).first().waitFor({ state: 'visible', timeout: 15_000 })
          if (await login.isVisible()) await signIn(relaunched, identity.email, identity.password)
          await restoredSession.click()
          const restored = relaunched.page.getByTestId('creation-workbench')
          await expect(restored.getByTestId('composer-prompt')).toHaveText(prompt)

          await relaunched.page.getByRole('link', { name: '资产' }).click()
          await expect(relaunched.page.getByTestId('asset-card')).toHaveCount(2)
          await relaunched.page
            .getByRole('button', { name: publishedAssetName ?? '', exact: true })
            .click()
          const deleteDialog = relaunched.page.getByRole('dialog')
          relaunched.page.once('dialog', (confirmation) => void confirmation.accept())
          await deleteDialog.getByRole('button', { name: '删除', exact: true }).click()
          await expect(deleteDialog).toBeHidden()
          await expect(relaunched.page.getByTestId('asset-card')).toHaveCount(1)

          await relaunched.page.getByRole('link', { name: '灵感' }).click()
          await expect(relaunched.page.getByTestId('inspiration-card')).toHaveCount(1)
          await relaunched.page.getByRole('button', { name: /^打开灵感 / }).click()
          const publishedDialog = relaunched.page.getByRole('dialog')
          relaunched.page.once('dialog', (confirmation) => void confirmation.accept())
          await publishedDialog.getByRole('button', { name: '撤回' }).click()
          await expect(publishedDialog).toBeHidden()
          await expect(relaunched.page.getByTestId('inspiration-card')).toHaveCount(0)

          await relaunched.page.getByRole('link', { name: '资产' }).click()
          await relaunched.page.getByRole('button', { name: /^打开资产 / }).click()
          const republishDialog = relaunched.page.getByRole('dialog')
          relaunched.page.once('dialog', (confirmation) => void confirmation.accept())
          await republishDialog.getByRole('button', { name: '发布到灵感' }).click()
          await expect(republishDialog.getByRole('button', { name: '撤回发布' })).toBeVisible()
          await relaunched.page.keyboard.press('Escape')
          await relaunched.page.getByRole('link', { name: '灵感' }).click()
          await expect(relaunched.page.getByTestId('inspiration-card')).toHaveCount(1)
          await relaunched.page.getByRole('button', { name: /^打开灵感 / }).click()
          const memberSafetyDetail = relaunched.page.getByRole('dialog')
          await expect(memberSafetyDetail.getByRole('region', { name: /安全限制/ })).toHaveCount(0)
          await relaunched.page.keyboard.press('Escape')

          const safetyAdmin = await launchTestApp({
            userDataDir: adminUserDataDir,
            systemLanguages: ['zh-CN'],
            serverUrl: identityServer.serverUrl
          })
          try {
            await safetyAdmin.page.setViewportSize({ width: 960, height: 600 })
            const adminLogin = safetyAdmin.page.getByRole('heading', { name: '登录 Nevix AI' })
            const adminInspiration = safetyAdmin.page.getByRole('heading', { name: '灵感' })
            await adminLogin
              .or(adminInspiration)
              .first()
              .waitFor({ state: 'visible', timeout: 15_000 })
            if (await adminLogin.isVisible()) {
              await signIn(safetyAdmin, identityServer.adminEmail, identityServer.adminPassword)
            }

            const firstScreenSamples: number[] = []
            for (let sample = 0; sample < 20; sample += 1) {
              await safetyAdmin.page.getByRole('link', { name: '资产' }).first().click()
              await expect(safetyAdmin.page.getByRole('heading', { name: '资产' })).toBeVisible()
              const startedAt = Date.now()
              await safetyAdmin.page.getByRole('link', { name: '灵感' }).first().click()
              await expect(safetyAdmin.page.getByTestId('inspiration-card').first()).toBeVisible()
              firstScreenSamples.push(Date.now() - startedAt)
            }
            expect(percentile95(firstScreenSamples)).toBeLessThan(2_000)

            const listRequest = /\/creation\/inspiration(?:\?|$)/
            await safetyAdmin.page.route(
              listRequest,
              (route) => route.abort('internetdisconnected'),
              { times: 1 }
            )
            await safetyAdmin.page.getByRole('link', { name: '资产' }).click()
            await safetyAdmin.page.getByRole('link', { name: '灵感' }).click()
            await expect(safetyAdmin.page.getByRole('alert')).toContainText('无法读取灵感')
            const recoveryStartedAt = Date.now()
            await safetyAdmin.page.getByRole('button', { name: '重试' }).click()
            await expect(safetyAdmin.page.getByTestId('inspiration-card')).toHaveCount(1, {
              timeout: 10_000
            })
            expect(Date.now() - recoveryStartedAt).toBeLessThan(10_000)
            expect(
              await safetyAdmin.page.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth
              )
            ).toBe(true)

            await safetyAdmin.page.getByRole('button', { name: /^打开灵感 / }).click()
            const safetyDetail = safetyAdmin.page.getByRole('dialog')
            const assetRestriction = safetyDetail.getByRole('region', {
              name: '资产安全限制'
            })
            const publicationRestriction = safetyDetail.getByRole('region', {
              name: '发布安全限制'
            })
            await expect(assetRestriction.getByRole('button', { name: '限制资产' })).toBeVisible()
            await expect(
              publicationRestriction.getByRole('button', { name: '限制发布' })
            ).toBeVisible()

            const restrictionSamples: number[] = []
            for (let sample = 0; sample < 20; sample += 1) {
              const restricting = sample % 2 === 0
              const actionName = restricting ? '限制资产' : '解除资产限制'
              const settledName = restricting ? '解除资产限制' : '限制资产'
              safetyAdmin.page.once('dialog', (confirmation) => void confirmation.accept())
              const startedAt = Date.now()
              await assetRestriction.getByRole('button', { name: actionName }).click()
              await expect(
                assetRestriction.getByRole('button', { name: settledName })
              ).toBeVisible()
              restrictionSamples.push(Date.now() - startedAt)
            }
            expect(percentile95(restrictionSamples)).toBeLessThan(2_000)
            safetyAdmin.page.once('dialog', (confirmation) => void confirmation.accept())
            await assetRestriction.getByRole('button', { name: '限制资产' }).click()
            await expect(safetyDetail.getByRole('status')).toContainText('资产限制已生效')
            await expect(
              assetRestriction.getByRole('button', { name: '解除资产限制' })
            ).toBeVisible()
            await expect(
              publicationRestriction.getByRole('button', { name: '限制发布' })
            ).toBeVisible()

            const convergenceStartedAt = Date.now()
            await relaunched.page.getByRole('link', { name: '资产' }).first().click()
            await relaunched.page.getByRole('link', { name: '灵感' }).first().click()
            await expect(relaunched.page.getByTestId('inspiration-card')).toHaveCount(0, {
              timeout: 10_000
            })
            expect(Date.now() - convergenceStartedAt).toBeLessThan(10_000)

            safetyAdmin.page.once('dialog', (confirmation) => void confirmation.accept())
            await assetRestriction.getByRole('button', { name: '解除资产限制' }).click()
            await expect(safetyDetail.getByRole('status')).toContainText('资产限制已解除')

            const publishRemainingAsset = async (): Promise<string> => {
              await relaunched.page.getByRole('link', { name: '资产' }).first().click()
              await relaunched.page.getByRole('button', { name: /^打开资产 / }).click()
              const remainingAsset = relaunched.page.getByRole('dialog')
              relaunched.page.once('dialog', (confirmation) => void confirmation.accept())
              await remainingAsset.getByRole('button', { name: '发布到灵感' }).click()
              await expect(remainingAsset.getByRole('button', { name: '撤回发布' })).toBeVisible()
              await relaunched.page.keyboard.press('Escape')
              await relaunched.page.getByRole('link', { name: '灵感' }).first().click()
              await expect(relaunched.page.getByTestId('inspiration-card')).toHaveCount(1)
              const openPublication = relaunched.page.getByRole('button', { name: /^打开灵感 / })
              const label = await openPublication.getAttribute('aria-label')
              expect(label).not.toBeNull()
              return label ?? ''
            }

            const publicationAfterAssetRestriction = await publishRemainingAsset()
            await safetyAdmin.page.keyboard.press('Escape')
            await safetyAdmin.page.getByRole('link', { name: '资产' }).click()
            await safetyAdmin.page.getByRole('link', { name: '灵感' }).click()
            await expect(safetyAdmin.page.getByTestId('inspiration-card')).toHaveCount(1)
            await safetyAdmin.page.getByRole('button', { name: /^打开灵感 / }).click()
            await expect(
              publicationRestriction.getByRole('button', { name: '限制发布' })
            ).toBeVisible()

            safetyAdmin.page.once('dialog', (confirmation) => void confirmation.accept())
            await publicationRestriction.getByRole('button', { name: '限制发布' }).click()
            await expect(safetyDetail.getByRole('status')).toContainText('发布限制已生效')

            await relaunched.page.getByRole('link', { name: '资产' }).first().click()
            await relaunched.page.getByRole('button', { name: /^打开资产 / }).click()
            const blockedRepublish = relaunched.page.getByRole('dialog')
            await expect(blockedRepublish.getByRole('button', { name: '发布到灵感' })).toHaveCount(
              0
            )
            await relaunched.page.keyboard.press('Escape')
            await relaunched.page.getByRole('link', { name: '灵感' }).first().click()
            await expect(relaunched.page.getByTestId('inspiration-card')).toHaveCount(0)

            safetyAdmin.page.once('dialog', (confirmation) => void confirmation.accept())
            await publicationRestriction.getByRole('button', { name: '解除发布限制' }).click()
            await expect(safetyDetail.getByRole('status')).toContainText('发布限制已解除')
            await relaunched.page.getByRole('link', { name: '资产' }).first().click()
            await relaunched.page.getByRole('link', { name: '灵感' }).first().click()
            await expect(relaunched.page.getByTestId('inspiration-card')).toHaveCount(0)
            const publicationAfterDirectRestriction = await publishRemainingAsset()
            expect(publicationAfterDirectRestriction).not.toBe(publicationAfterAssetRestriction)
          } finally {
            await safetyAdmin.electronApp.close()
          }
        } finally {
          await relaunched.electronApp.close()
        }
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
      await rm(adminUserDataDir, { recursive: true, force: true })
      await rm(downloadDir, { recursive: true, force: true })
    }
  }
)
