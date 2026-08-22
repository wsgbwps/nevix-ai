import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp, signOutFromUserMenu } from '../helpers/electron-app'
import {
  createStableTeamUser,
  readIdentityServerConfig,
  uniqueIdentity
} from '../auth/helpers/identity-server'

const identityServer = readIdentityServerConfig()

async function expectSignedInHomeWithStartupRetry(page: Page): Promise<void> {
  const homeHeading = page.getByRole('heading', { name: '使用 Nevix AI 创作' })
  const retryButton = page.getByRole('button', { name: '重试', exact: true })
  await expect(homeHeading.or(retryButton)).toBeVisible({ timeout: 15_000 })
  if (await retryButton.isVisible()) await retryButton.click()
  await expect(homeHeading).toBeVisible()
}

test(
  'signed-in users land in the App Shell with the brand slot and the home entry',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(60_000)
    test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
    if (!identityServer) return

    const identity = uniqueIdentity('app-shell-presentation')
    await createStableTeamUser(identityServer, identity)
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-app-shell-presentation-'))

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['zh-CN'] })
      try {
        await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
        await launched.page.getByLabel('邮箱').fill(identity.email)
        await launched.page.getByLabel('密码').fill(identity.password)
        await launched.page.getByRole('button', { name: '登录', exact: true }).click()
        await expectSignedInHomeWithStartupRetry(launched.page)

        // 品牌槽位：产品标识占位、不可切换，且不出现下拉死入口。
        const brandButton = launched.page.getByRole('button', { name: 'Nevix AI' })
        await expect(brandButton).toBeVisible()
        await expect(brandButton).toContainText('Nevix AI')
        await expect(brandButton).toBeDisabled()
        await expect(launched.page.getByRole('menu')).toHaveCount(0)

        // NavMain 仅“首页”一个真实入口，位于当前路由位置。
        const sidebar = launched.page.locator('[data-slot="sidebar"]')
        const homeEntry = sidebar.getByRole('link', { name: '首页' })
        await expect(homeEntry).toBeVisible()

        // 内容区头部：SidebarTrigger 与反映当前路由位置的 Breadcrumb。
        await expect(
          launched.page.getByRole('main').getByRole('button', { name: '切换侧边栏' })
        ).toBeVisible()
        await expect(
          launched.page.getByLabel('breadcrumb').getByText('首页', { exact: true })
        ).toBeVisible()

        // NavUser 显示登录邮箱与首字母头像。
        const userMenu = launched.page.getByRole('button', { name: '用户菜单' })
        await expect(userMenu).toContainText(identity.email)
        await expect(
          userMenu.getByText(identity.email.charAt(0).toUpperCase(), { exact: true })
        ).toBeVisible()
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)

test('the sidebar collapses to an icon rail and expands again', async () => {
  test.setTimeout(60_000)
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const identity = uniqueIdentity('app-shell-collapse')
  await createStableTeamUser(identityServer, identity)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-app-shell-collapse-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['zh-CN'] })
    try {
      await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      await launched.page.getByLabel('邮箱').fill(identity.email)
      await launched.page.getByLabel('密码').fill(identity.password)
      await launched.page.getByRole('button', { name: '登录', exact: true }).click()
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()

      const toggle = launched.page.getByRole('main').getByRole('button', { name: '切换侧边栏' })
      const sidebar = launched.page.locator('[data-slot="sidebar"]')
      const homeEntry = sidebar.getByRole('link', { name: '首页' })
      const brandButton = launched.page.getByRole('button', { name: 'Nevix AI' })
      await expect(homeEntry).toBeVisible()
      await expect(brandButton).toContainText('Nevix AI')

      // 折叠为图标形态：文本入口隐藏，仅图标保留。
      await toggle.click()
      await expect(homeEntry).toHaveCount(0)
      await expect(brandButton.getByText('Nevix AI', { exact: true })).toBeHidden()

      // 再次展开后全部恢复。
      await toggle.click()
      await expect(homeEntry).toBeVisible()
      await expect(brandButton).toContainText('Nevix AI')
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('the user menu shows the signed-in email and signs out of this device', async () => {
  test.setTimeout(60_000)
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const identity = uniqueIdentity('app-shell-user-menu')
  await createStableTeamUser(identityServer, identity)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-app-shell-user-menu-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['zh-CN'] })
    try {
      await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      await launched.page.getByLabel('邮箱').fill(identity.email)
      await launched.page.getByLabel('密码').fill(identity.password)
      await launched.page.getByRole('button', { name: '登录', exact: true }).click()
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()

      // 用户菜单展示登录邮箱与退出当前设备入口。
      await launched.page.getByRole('button', { name: '用户菜单' }).click()
      const menu = launched.page.getByRole('menu')
      await expect(menu).toBeVisible()
      await expect(menu).toContainText(identity.email)
      await expect(menu.getByRole('menuitem', { name: '退出当前设备' })).toBeVisible()

      // 从用户菜单退出登录后回到登录界面。
      await signOutFromUserMenu(launched.page)
      await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toHaveCount(
        0
      )
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})
