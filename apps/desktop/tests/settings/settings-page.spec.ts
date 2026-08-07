import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp, openSettingsFromUserMenu } from '../helpers/electron-app'
import {
  createAuthUser,
  deleteAuthUser,
  readAuthHarnessConfig,
  uniqueAuthIdentity
} from '../auth/helpers/supabase-auth'

const authHarness = readAuthHarnessConfig()

test('signed-in users reach the standalone Settings Page from the user menu and return to the App Shell', async () => {
  test.setTimeout(60_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('settings-page-presentation')
  const userId = await createAuthUser(authHarness, identity, true)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-settings-page-presentation-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['zh-CN'] })
    try {
      await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      await launched.page.getByLabel('邮箱').fill(identity.email)
      await launched.page.getByLabel('密码').fill(identity.password)
      await launched.page.getByRole('button', { name: '登录', exact: true }).click()
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()

      await openSettingsFromUserMenu(launched.page)

      // 设置页是独立全屏界面：App Shell 的侧边栏不再出现。
      await expect(launched.page.getByRole('heading', { name: '设置' })).toBeVisible()
      await expect(launched.page.getByRole('button', { name: '切换侧边栏' })).toHaveCount(0)

      // 左侧设置导航：顶部"返回应用"链接 + 账户组中的个人资料和语言。
      await expect(launched.page.getByRole('link', { name: '返回应用' })).toBeVisible()
      const settingsNav = launched.page.getByRole('navigation', { name: '设置' })
      await expect(settingsNav.getByText('账户')).toBeVisible()
      await expect(settingsNav.getByRole('link', { name: '个人资料' })).toBeVisible()
      await expect(settingsNav.getByRole('link', { name: '语言' })).toBeVisible()

      // 右侧内容区呈现语言设置 section，Language Mode 控件为下拉。
      const languageModeSelect = launched.page.getByRole('combobox', { name: '界面语言' })
      await expect(languageModeSelect).toBeVisible()
      await expect(languageModeSelect).toContainText('跟随系统')

      // "返回应用"链接回到 App Shell。
      await launched.page.getByRole('link', { name: '返回应用' }).click()
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()
      await expect(launched.page.getByRole('heading', { name: '设置' })).toHaveCount(0)
      await expect(
        launched.page.getByRole('main').getByRole('button', { name: '切换侧边栏' })
      ).toBeVisible()
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, userId)
  }
})

test('the Settings Page Select switches the Interface Language without reloading', async () => {
  test.setTimeout(60_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('settings-page-language')
  const userId = await createAuthUser(authHarness, identity, true)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-settings-page-language-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['zh-CN'] })
    try {
      await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      await launched.page.getByLabel('邮箱').fill(identity.email)
      await launched.page.getByLabel('密码').fill(identity.password)
      await launched.page.getByRole('button', { name: '登录', exact: true }).click()
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()

      await openSettingsFromUserMenu(launched.page)

      let navigationCount = 0
      launched.page.on('framenavigated', (frame) => {
        if (frame === launched.page.mainFrame()) navigationCount += 1
      })

      await launched.page.getByRole('combobox', { name: '界面语言' }).click()
      await launched.page.getByRole('option', { name: 'English' }).click()

      // 设置页全部 Localized Surface 立即以新 Interface Language 呈现。
      await expect(launched.page.getByRole('heading', { name: 'Settings' })).toBeVisible()
      await expect(launched.page.getByRole('link', { name: 'Back to app' })).toBeVisible()
      const settingsNav = launched.page.getByRole('navigation', { name: 'Settings' })
      await expect(settingsNav.getByText('Account')).toBeVisible()
      await expect(settingsNav.getByRole('link', { name: 'Profile' })).toBeVisible()
      await expect(settingsNav.getByRole('link', { name: 'Language' })).toBeVisible()
      await expect(
        launched.page.getByRole('combobox', { name: 'Interface language' })
      ).toContainText('English')

      // 返回 App Shell 后首页文案同样即时切换。
      await launched.page.getByRole('link', { name: 'Back to app' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      expect(navigationCount).toBe(0)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, userId)
  }
})
