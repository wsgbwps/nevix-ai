import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp, openSettingsFromUserMenu } from '../helpers/electron-app'
import { readIdentityServerConfig } from '../auth/helpers/identity-server'

const identityServer = readIdentityServerConfig()

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('邮箱').fill(email)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

/** The join-code card on the Users settings screen: list scoped to its rows. */
function joinCodeRow(page: Page, code: string): ReturnType<Page['getByRole']> {
  return page
    .getByRole('list', { name: '活跃加入码列表' })
    .getByRole('listitem')
    .filter({ hasText: code })
}

/**
 * The governance loop issue #120 ships for the Desktop: the Admin issues a
 * join code with a note, reads its plaintext right in the active list, and
 * revokes it — after which the card shows self-registration closed again,
 * and the audit log carries both actions.
 */
test('Admin issues a join code, sees its plaintext, and revokes it', async () => {
  test.setTimeout(180_000)
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-admin-join-codes-'))

  try {
    const app = await launchTestApp({
      userDataDir,
      systemLanguages: ['zh-CN'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      const page = app.page
      await signIn(page, identityServer!.adminEmail, identityServer!.adminPassword)
      await expect(page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()

      // The join-code card shares the Users settings screen with user
      // management; a fresh deployment has no active codes.
      await openSettingsFromUserMenu(page)
      await page
        .getByRole('navigation', { name: '设置' })
        .getByRole('button', { name: '用户管理' })
        .click()
      await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible()
      await expect(page.getByRole('heading', { name: '加入码' })).toBeVisible()
      await expect(page.getByText('暂无活跃加入码，自注册已关闭。')).toBeVisible()

      // 签发：with a note saying where the code was posted.
      await page.getByRole('button', { name: '签发加入码', exact: true }).click()
      const issueDialog = page.getByRole('dialog', { name: '签发加入码' })
      await issueDialog.getByLabel(/备注/).fill('E2E 渠道')
      await issueDialog.getByRole('button', { name: '签发加入码' }).click()

      // The plaintext is the point: the row shows the 8-character code and
      // the notice repeats it.
      const notice = page.getByRole('status').filter({ hasText: '已签发加入码' })
      await expect(notice).toBeVisible()
      const noticedCode = (await notice.textContent())?.match(/[0-9A-HJKMNP-TV-Z]{8}/)?.[0]
      expect(noticedCode).toBeDefined()

      const row = joinCodeRow(page, noticedCode!)
      await expect(row).toBeVisible()
      await expect(row).toContainText('E2E 渠道')
      const listedCode = (await row.locator('.font-mono').textContent())?.trim()
      expect(listedCode).toBe(noticedCode)

      // 吊销：confirmation names the code; the row leaves the list and the
      // card reports self-registration closed again.
      await row.getByRole('button', { name: `吊销 ${noticedCode}` }).click()
      const revokeDialog = page.getByRole('dialog', { name: `吊销加入码 ${noticedCode}` })
      await expect(revokeDialog).toBeVisible()
      await revokeDialog.getByRole('button', { name: '吊销', exact: true }).click()

      await expect(page.getByRole('status').filter({ hasText: '已吊销' })).toBeVisible()
      await expect(joinCodeRow(page, noticedCode!)).toHaveCount(0)
      await expect(page.getByText('暂无活跃加入码，自注册已关闭。')).toBeVisible()

      // The audit trail names both actions.
      await page
        .getByRole('navigation', { name: '设置' })
        .getByRole('button', { name: '审计日志' })
        .click()
      await expect(page.getByRole('heading', { name: '审计日志' })).toBeVisible()
      const auditList = page.getByRole('list', { name: '审计条目' })
      await expect(auditList.getByText('签发加入码').first()).toBeVisible()
      await expect(auditList.getByText('吊销加入码').first()).toBeVisible()
    } finally {
      await app.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})
