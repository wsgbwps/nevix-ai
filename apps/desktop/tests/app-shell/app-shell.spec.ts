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
  const homeHeading = page.getByRole('heading', { name: '灵感' })
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
        await expectSignedInHomeWithStartupRetry(launched.page)

        const sidebar = launched.page.locator('[data-slot="sidebar"]')
        // 品牌槽位固定，侧边栏开关与创作会话导航都属于侧栏本身。
        await expect(sidebar.getByText('Nevix AI', { exact: true })).toBeVisible()
        await expect(sidebar.locator('[data-slot="sidebar-trigger"]')).toBeVisible()
        const homeEntry = sidebar.getByRole('link', { name: '灵感' })
        await expect(homeEntry).toBeVisible()
        await expect(sidebar.getByRole('link', { name: 'AI 创作' })).toHaveCount(0)
        await expect(sidebar.getByTestId('creation-session-navigation')).toBeVisible()
        await expect(sidebar.getByTestId('session-new')).toBeVisible()

        // 主导航与会话列表之间有一条淡淡的分割线。
        const divider = sidebar.locator('[data-slot="sidebar-separator"]')
        await expect(divider).toBeVisible()
        await expect
          .poll(async () => {
            const [assetsBox, dividerBox, sessionsBox] = await Promise.all([
              sidebar.getByRole('link', { name: '资产' }).boundingBox(),
              divider.boundingBox(),
              sidebar.getByTestId('creation-session-navigation').boundingBox()
            ])
            if (assetsBox === null || dividerBox === null || sessionsBox === null)
              return 'measuring'
            if (assetsBox.y + assetsBox.height > dividerBox.y)
              return 'divider crosses the navigation'
            if (dividerBox.y + dividerBox.height > sessionsBox.y)
              return 'divider crosses the sessions'
            return 'ok'
          })
          .toBe('ok')

        // 内容区不再重复侧栏开关或路由 Breadcrumb。
        await expect(
          launched.page.getByRole('main').getByRole('button', { name: '切换侧边栏' })
        ).toHaveCount(0)
        await expect(launched.page.getByLabel('breadcrumb')).toHaveCount(0)

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
      await expect(launched.page.getByRole('heading', { name: '灵感' })).toBeVisible()

      const sidebar = launched.page.locator('[data-slot="sidebar"]')
      const toggle = sidebar.locator('[data-slot="sidebar-trigger"]')
      const homeEntry = sidebar.getByRole('link', { name: '灵感' })
      const brand = sidebar.getByText('Nevix AI', { exact: true })
      await expect(homeEntry).toBeVisible()
      await expect(brand).toBeVisible()
      await expect(sidebar.getByTestId('session-new')).toBeVisible()

      // 折叠为图标形态：文本入口隐藏，仅图标保留。
      await toggle.click()
      await expect(homeEntry).toHaveCount(0)
      await expect(brand).toBeHidden()
      await expect(sidebar.getByTestId('session-new')).toBeVisible()
      await expect
        .poll(() => launched.page.evaluate(() => localStorage.getItem('sidebar_state')))
        .toBe('false')

      // 图标栏落定后，品牌标记居中，开关覆盖它的位置且默认隐藏。
      const rail = sidebar.locator('[data-slot="sidebar-container"]')
      await expect
        .poll(async () => {
          const box = await rail.boundingBox()
          return box === null ? null : Math.round(box.width)
        })
        .toBe(48)
      await expect(sidebar.getByTestId('sidebar-brand')).toBeVisible()
      await expect(toggle).toHaveCSS('opacity', '0')
      await toggle.hover()
      await expect(toggle).toHaveCSS('opacity', '1')

      // 会话创建按钮在自己的行里，不再压住会话列表。
      const createBox = await sidebar.getByTestId('session-new').boundingBox()
      const listBox = await sidebar.getByTestId('session-list').boundingBox()
      expect(createBox).not.toBeNull()
      expect(listBox).not.toBeNull()
      if (createBox !== null && listBox !== null) {
        expect(createBox.y + createBox.height).toBeLessThanOrEqual(listBox.y)
      }

      // 路由各自重建 AppShell；设备侧边栏状态仍由本地存储恢复。
      await sidebar.locator('[href="/assets"]').click()
      await expect(launched.page.getByRole('heading', { name: '资产' })).toBeVisible()
      await expect(sidebar).toHaveAttribute('data-state', 'collapsed')

      // 再次展开后全部恢复。
      await toggle.click()
      await expect(homeEntry).toBeVisible()
      await expect(brand).toBeVisible()
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
      await expect(launched.page.getByRole('heading', { name: '灵感' })).toBeVisible()

      // 用户菜单展示登录邮箱与退出当前设备入口。
      await launched.page.getByRole('button', { name: '用户菜单' }).click()
      const menu = launched.page.getByRole('menu')
      await expect(menu).toBeVisible()
      await expect(menu).toContainText(identity.email)
      await expect(menu.getByRole('menuitem', { name: '退出当前设备' })).toBeVisible()

      // 从用户菜单退出登录后回到登录界面。
      await signOutFromUserMenu(launched.page)
      await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      await expect(launched.page.getByRole('heading', { name: '灵感' })).toHaveCount(0)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})
