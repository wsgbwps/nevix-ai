import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp, signOutFromUserMenu } from '../helpers/electron-app'
import {
  createAuthUser,
  deleteAuthUser,
  readAuthHarnessConfig,
  uniqueAuthIdentity
} from '../auth/helpers/supabase-auth'
import { seedOrganizationWithMembership } from '../organization/helpers/organization-seed'

const authHarness = readAuthHarnessConfig()

test(
  'signed-in users land in the App Shell with the organization switcher slot and the home entry',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(60_000)
    test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
    if (!authHarness) return

    const identity = uniqueAuthIdentity('app-shell-presentation')
    const userId = await createAuthUser(authHarness, identity, true)
    await seedOrganizationWithMembership(userId, { name: 'Nebula Design' })
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-app-shell-presentation-'))

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['zh-CN'] })
      try {
        await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
        await launched.page.getByLabel('邮箱').fill(identity.email)
        await launched.page.getByLabel('密码').fill(identity.password)
        await launched.page.getByRole('button', { name: '登录', exact: true }).click()
        await expect(
          launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })
        ).toBeVisible({ timeout: 15_000 })

        // 组织切换器槽位：产品标识占位、不可切换，且不出现下拉死入口。
        const organizationSwitcher = launched.page.getByRole('button', { name: '组织切换器' })
        await expect(organizationSwitcher).toBeVisible()
        await expect(organizationSwitcher).toContainText('Nevix AI')
        await expect(organizationSwitcher).toBeDisabled()
        await expect(launched.page.getByRole('menu')).toHaveCount(0)

        // NavMain 仅"首页"一个真实入口，位于当前路由位置。
        const sidebar = launched.page.locator('[data-slot="sidebar"]')
        const homeEntry = sidebar.getByRole('link', { name: '首页' })
        await expect(homeEntry).toBeVisible()
        await expect(sidebar.getByRole('link', { name: '首页', current: 'page' })).toHaveCount(1)

        // 内容区头部：SidebarTrigger 与反映当前路由位置的 Breadcrumb。
        await expect(
          launched.page.getByRole('main').getByRole('button', { name: '切换侧边栏' })
        ).toBeVisible()
        await expect(
          launched.page
            .getByLabel('breadcrumb')
            .getByRole('link', { name: '首页', current: 'page' })
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
      await deleteAuthUser(authHarness, userId)
    }
  }
)

test('the sidebar collapses to an icon rail and expands again', async () => {
  test.setTimeout(60_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('app-shell-collapse')
  const userId = await createAuthUser(authHarness, identity, true)
  await seedOrganizationWithMembership(userId, { name: 'Nebula Collapse' })
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
      const organizationSwitcher = launched.page.getByRole('button', { name: '组织切换器' })
      await expect(homeEntry).toBeVisible()
      await expect(organizationSwitcher).toContainText('Nevix AI')

      // 折叠为图标形态：文本入口隐藏，仅图标保留。
      await toggle.click()
      await expect(homeEntry).toHaveCount(0)
      await expect(organizationSwitcher.getByText('Nevix AI', { exact: true })).toBeHidden()

      // 再次展开后全部恢复。
      await toggle.click()
      await expect(homeEntry).toBeVisible()
      await expect(organizationSwitcher).toContainText('Nevix AI')
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, userId)
  }
})

test('the user menu shows the signed-in email and signs out of this device', async () => {
  test.setTimeout(60_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('app-shell-user-menu')
  const userId = await createAuthUser(authHarness, identity, true)
  await seedOrganizationWithMembership(userId, { name: 'Nebula User Menu' })
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
    await deleteAuthUser(authHarness, userId)
  }
})
