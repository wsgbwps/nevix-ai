import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  expectMainWindowCount,
  launchTestApp,
  openSettingsFromUserMenu,
  requestOrdinaryWindowClose
} from '../helpers/electron-app'
import {
  createAuthUser,
  deleteAuthUser,
  readAuthHarnessConfig,
  uniqueAuthIdentity
} from '../auth/helpers/supabase-auth'
import { seedOrganizationWithMembership } from '../organization/helpers/organization-seed'

const authHarness = readAuthHarnessConfig()

async function expectSignedInHomeWithStartupRetry(page: Page): Promise<void> {
  const homeHeading = page.getByRole('heading', { name: '使用 Nevix AI 创作' })
  const retryButton = page.getByRole('button', { name: '重试', exact: true })
  await expect(homeHeading.or(retryButton)).toBeVisible()
  if (await retryButton.isVisible()) await retryButton.click()
  await expect(homeHeading).toBeVisible()
}

test('signed-in users reach one focused Settings Section and return to its App source @smoke', async () => {
  test.setTimeout(60_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('settings-page-presentation')
  const userId = await createAuthUser(authHarness, identity, true)
  await seedOrganizationWithMembership(userId, { name: '设置页组织' })
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-settings-page-presentation-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['zh-CN'] })
    try {
      await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      await launched.page.getByLabel('邮箱').fill(identity.email)
      await launched.page.getByLabel('密码').fill(identity.password)
      await launched.page.getByRole('button', { name: '登录', exact: true }).click()
      await expectSignedInHomeWithStartupRetry(launched.page)

      await openSettingsFromUserMenu(launched.page)

      // 设置页是独立全屏界面：App Shell 的侧边栏不再出现。
      await expect(launched.page.getByRole('heading', { name: '设置' })).toBeVisible()
      await expect(launched.page.getByRole('button', { name: '切换侧边栏' })).toHaveCount(0)

      // 左侧设置导航：顶部"返回应用"操作 + 账户组中的个人资料和语言。
      await expect(launched.page.getByRole('button', { name: '返回应用' })).toBeVisible()
      const settingsNav = launched.page.getByRole('navigation', { name: '设置' })
      await expect(settingsNav.getByText('账户')).toBeVisible()
      const profileSection = settingsNav.getByRole('button', { name: '个人资料' })
      const languageSection = settingsNav.getByRole('button', { name: '语言' })
      await expect(profileSection).toHaveAttribute('aria-pressed', 'true')
      await expect(languageSection).toHaveAttribute('aria-pressed', 'false')

      // 普通入口默认 Profile；切换只挂载目标 Section。
      await expect(launched.page.getByRole('heading', { name: '个人资料' })).toBeVisible()
      const languageModeSelect = launched.page.getByRole('combobox', { name: '界面语言' })
      await expect(languageModeSelect).toHaveCount(0)
      await languageSection.click()
      await expect(languageModeSelect).toBeVisible()
      await expect(languageModeSelect).toContainText('跟随系统')
      await expect(launched.page.getByRole('heading', { name: '个人资料' })).toHaveCount(0)

      // Section 切换 replace 当前 entry，因此返回不会回放 Profile。
      await launched.page.getByRole('button', { name: '返回应用' }).click()
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
  await seedOrganizationWithMembership(userId, { name: '语言切换组织' })
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

      await launched.page
        .getByRole('navigation', { name: '设置' })
        .getByRole('button', {
          name: '语言'
        })
        .click()

      let navigationCount = 0
      launched.page.on('framenavigated', (frame) => {
        if (frame === launched.page.mainFrame()) navigationCount += 1
      })

      await launched.page.getByRole('combobox', { name: '界面语言' }).click()
      await launched.page.getByRole('option', { name: 'English' }).click()

      // 设置页全部 Localized Surface 立即以新 Interface Language 呈现。
      await expect(launched.page.getByRole('heading', { name: 'Settings' })).toBeVisible()
      await expect(launched.page.getByRole('button', { name: 'Back to app' })).toBeVisible()
      const settingsNav = launched.page.getByRole('navigation', { name: 'Settings' })
      await expect(settingsNav.getByText('Account')).toBeVisible()
      await expect(settingsNav.getByRole('button', { name: 'Profile' })).toBeVisible()
      await expect(settingsNav.getByRole('button', { name: 'Language' })).toBeVisible()
      await expect(
        launched.page.getByRole('combobox', { name: 'Interface language' })
      ).toContainText('English')

      // 返回 App Shell 后首页文案同样即时切换。
      await launched.page.getByRole('button', { name: 'Back to app' }).click()
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

test('dirty Profile uses one discard decision for Section changes and ordinary close', async () => {
  test.setTimeout(90_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('settings-profile-dirty')
  const userId = await createAuthUser(authHarness, identity, true)
  await seedOrganizationWithMembership(userId, { name: '草稿保护组织' })
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-settings-profile-dirty-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['zh-CN'] })
    try {
      await launched.page.getByLabel('邮箱').fill(identity.email)
      await launched.page.getByLabel('密码').fill(identity.password)
      await launched.page.getByRole('button', { name: '登录', exact: true }).click()
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()
      await openSettingsFromUserMenu(launched.page)

      const displayName = launched.page.getByLabel('显示名')
      await expect(displayName).toBeEnabled()
      const authoritativeName = await displayName.inputValue()
      const draftName = `${authoritativeName || '用户'} 草稿`
      let profileWrites = 0
      launched.page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().includes('/rest/v1/profiles')) {
          profileWrites += 1
        }
      })

      await displayName.fill(draftName)
      await launched.page.getByRole('button', { name: '返回应用' }).click()

      const discardDialog = launched.page.getByRole('dialog', { name: '丢弃未保存的更改？' })
      await expect(discardDialog).toBeVisible()
      await discardDialog.getByRole('button', { name: '继续编辑' }).click()
      await expect(displayName).toHaveValue(draftName)
      await expect(launched.page.getByRole('heading', { name: '设置' })).toBeVisible()

      await launched.page
        .getByRole('navigation', { name: '设置' })
        .getByRole('button', {
          name: '语言'
        })
        .click()

      await expect(discardDialog).toBeVisible()
      await expect(discardDialog.getByRole('button')).toHaveCount(2)
      await discardDialog.getByRole('button', { name: '继续编辑' }).click()
      await expect(displayName).toHaveValue(draftName)

      await launched.page
        .getByRole('navigation', { name: '设置' })
        .getByRole('button', {
          name: '语言'
        })
        .click()
      await discardDialog.getByRole('button', { name: '丢弃更改' }).click()
      await expect(launched.page.getByRole('combobox', { name: '界面语言' })).toBeVisible()
      expect(profileWrites).toBe(0)

      // Re-entry remounts Profile and rereads its authoritative value.
      await launched.page
        .getByRole('navigation', { name: '设置' })
        .getByRole('button', {
          name: '个人资料'
        })
        .click()
      await expect(displayName).toHaveValue(authoritativeName)
      await displayName.fill(`${authoritativeName || '用户'} 关闭草稿`)

      await requestOrdinaryWindowClose(launched.electronApp)
      await expectMainWindowCount(launched.electronApp, 1)
      await expect(discardDialog).toBeVisible()
      await discardDialog.getByRole('button', { name: '继续编辑' }).click()
      await expect(displayName).toHaveValue(`${authoritativeName || '用户'} 关闭草稿`)

      const windowClosed = launched.page.waitForEvent('close')
      await requestOrdinaryWindowClose(launched.electronApp)
      await discardDialog.getByRole('button', { name: '丢弃更改' }).click()
      // Closing the last window quits the app on non-darwin platforms, so assert the window
      // close event itself rather than a live window count.
      await windowClosed
      expect(profileWrites).toBe(0)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, userId)
  }
})

test('ordinary close waits for Profile save failure and resumes after a successful retry', async () => {
  test.setTimeout(90_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('settings-profile-saving-close')
  const userId = await createAuthUser(authHarness, identity, true)
  await seedOrganizationWithMembership(userId, { name: '保存关闭组织' })
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-settings-profile-saving-close-'))

  interface ControlledProfileWrite {
    readonly started: Promise<void>
    readonly release: () => void
    readonly fail: boolean
    readonly waitForRelease: Promise<void>
    readonly markStarted: () => void
  }

  function controlledProfileWrite(fail: boolean): ControlledProfileWrite {
    let markStarted = (): void => undefined
    let release = (): void => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const waitForRelease = new Promise<void>((resolve) => {
      release = resolve
    })
    return {
      fail,
      started,
      release,
      waitForRelease,
      markStarted
    }
  }

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['zh-CN'] })
    try {
      await launched.page.getByLabel('邮箱').fill(identity.email)
      await launched.page.getByLabel('密码').fill(identity.password)
      await launched.page.getByRole('button', { name: '登录', exact: true }).click()
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()
      await openSettingsFromUserMenu(launched.page)

      const displayName = launched.page.getByLabel('显示名')
      await expect(displayName).toBeEnabled()

      // Establish the last successful authoritative value before inducing a failure.
      const successfulName = '最后一次成功写入'
      await displayName.fill(successfulName)
      await launched.page.getByRole('button', { name: '保存', exact: true }).click()
      await expect(launched.page.getByRole('status')).toContainText('显示名已更新。')

      let activeWrite: ControlledProfileWrite | undefined
      await launched.page.route('**/rest/v1/profiles**', async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue()
          return
        }
        const write = activeWrite
        if (!write) throw new Error('Profile write was not controlled by the test')
        write.markStarted()
        await write.waitForRelease
        if (write.fail) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'temporary profile failure' })
          })
        } else {
          await route.continue()
        }
      })

      const failedWrite = controlledProfileWrite(true)
      activeWrite = failedWrite
      const failedDraft = '失败时保留的草稿'
      await displayName.fill(failedDraft)
      await launched.page.getByRole('button', { name: '保存', exact: true }).click()
      await failedWrite.started
      await requestOrdinaryWindowClose(launched.electronApp)
      await expectMainWindowCount(launched.electronApp, 1)
      await expect(launched.page.getByRole('button', { name: '返回应用' })).toBeDisabled()
      failedWrite.release()

      await expect(launched.page.getByRole('alert')).toContainText('草稿已保留')
      await expect(displayName).toHaveValue(failedDraft)
      await expectMainWindowCount(launched.electronApp, 1)

      // Cancel still resolves to the last successful write after the failed attempt.
      await launched.page.getByRole('button', { name: '取消', exact: true }).click()
      await expect(displayName).toHaveValue(successfulName)

      const successfulWrite = controlledProfileWrite(false)
      activeWrite = successfulWrite
      await displayName.fill('关闭前成功保存')
      await launched.page.getByRole('button', { name: '保存', exact: true }).click()
      await successfulWrite.started
      const windowClosed = launched.page.waitForEvent('close')
      await requestOrdinaryWindowClose(launched.electronApp)
      await expectMainWindowCount(launched.electronApp, 1)
      successfulWrite.release()
      await windowClosed
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, userId)
  }
})
