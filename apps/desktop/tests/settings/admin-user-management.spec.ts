import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  expectMainWindowCount,
  launchTestApp,
  openSettingsFromUserMenu,
  requestOrdinaryWindowClose
} from '../helpers/electron-app'
import {
  createTeamUser,
  loginOutsideDesktop,
  readIdentityServerConfig,
  uniqueIdentity
} from '../auth/helpers/identity-server'

const identityServer = readIdentityServerConfig()

/** The random tag inside a unique identity's email; display names reuse it to stay single-use. */
function uniqueTag(identity: { readonly email: string }): string {
  const localPart = identity.email.split('@')[0] ?? ''
  return localPart.split('-').pop() ?? 'tag'
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('邮箱').fill(email)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

async function openUserManagementSection(page: Page): Promise<void> {
  await openSettingsFromUserMenu(page)
  await page
    .getByRole('navigation', { name: '设置' })
    .getByRole('button', { name: '用户管理' })
    .click()
  await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible()
}

async function createAccountThroughUi(
  page: Page,
  identity: { readonly email: string; readonly password: string },
  displayName: string
): Promise<void> {
  await page.getByRole('button', { name: '建号', exact: true }).click()
  const createDialog = page.getByRole('dialog', { name: '建号' })
  await createDialog.getByLabel('邮箱', { exact: true }).fill(identity.email)
  await createDialog.getByLabel('初始密码').fill(identity.password)
  await createDialog.getByLabel(/显示名/).fill(displayName)
  await createDialog.getByRole('button', { name: '创建账号' }).click()
  await expect(page.getByRole('status')).toContainText(`已创建 ${identity.email}`)
}

async function openRowActions(page: Page, email: string): Promise<void> {
  await page
    .getByRole('listitem')
    .filter({ hasText: email })
    .getByRole('button', { name: /的管理操作$/ })
    .click()
}

/**
 * The core governance loop this ticket ships: the Admin creates an account, that
 * account's first sign-in forces the initial-password change, and the Admin
 * disables it — after which the server rejects its sign-in.
 */
test('Admin manages the full lifecycle: create, forced first-login change, disable', async () => {
  test.setTimeout(180_000)
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const memberIdentity = uniqueIdentity('gov-core')
  const memberDisplayName = `治理流程 ${uniqueTag(memberIdentity)}`
  const chosenPassword = 'member-chosen horse battery staple'
  const adminUserDataDir = await mkdtemp(join(tmpdir(), 'nevix-admin-governance-'))
  const memberUserDataDir = await mkdtemp(join(tmpdir(), 'nevix-member-first-login-'))

  try {
    const adminApp = await launchTestApp({
      userDataDir: adminUserDataDir,
      systemLanguages: ['zh-CN'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      await signIn(adminApp.page, identityServer!.adminEmail, identityServer!.adminPassword)
      await expect(adminApp.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()

      // The administration group exists only for the Admin session.
      const adminNav = adminApp.page.getByRole('navigation', { name: '设置' })
      await openSettingsFromUserMenu(adminApp.page)
      await expect(adminNav.getByText('管理', { exact: true })).toBeVisible()
      await adminNav.getByRole('button', { name: '用户管理' }).click()
      await expect(adminApp.page.getByRole('heading', { name: '用户管理' })).toBeVisible()

      // 建号：the account is created with member role and the pending initial password.
      await createAccountThroughUi(adminApp.page, memberIdentity, memberDisplayName)
      await adminApp.page.getByLabel('搜索（邮箱或显示名）').fill(memberIdentity.email)
      const memberRow = adminApp.page
        .getByRole('list', { name: '用户列表' })
        .getByRole('listitem')
        .filter({ hasText: memberIdentity.email })
      await expect(memberRow).toBeVisible()
      await expect(memberRow.getByText('从未登录')).toBeVisible()
      await expect(memberRow.getByText('待改初始密码')).toBeVisible()
      await expect(memberRow.getByText('成员')).toBeVisible()

      // The fresh account's first sign-in forces the initial password change.
      const memberApp = await launchTestApp({
        userDataDir: memberUserDataDir,
        systemLanguages: ['zh-CN'],
        serverUrl: identityServer!.serverUrl
      })
      try {
        await signIn(memberApp.page, memberIdentity.email, memberIdentity.password)
        const changeHeading = memberApp.page.getByRole('heading', { name: '设置新密码' })
        await expect(changeHeading).toBeVisible()

        await memberApp.page.getByLabel('初始密码').fill(memberIdentity.password)
        await memberApp.page.getByLabel('新密码', { exact: true }).fill(chosenPassword)
        await memberApp.page.getByLabel('确认新密码').fill(chosenPassword)
        await memberApp.page.getByRole('button', { name: '更新密码并继续' }).click()
        await expect(
          memberApp.page.getByRole('heading', { name: '使用 Nevix AI 创作' })
        ).toBeVisible()

        // Member 角色看不到管理区。
        await openSettingsFromUserMenu(memberApp.page)
        const memberNav = memberApp.page.getByRole('navigation', { name: '设置' })
        await expect(memberNav.getByText('管理', { exact: true })).toHaveCount(0)
        await expect(memberNav.getByRole('button', { name: '用户管理' })).toHaveCount(0)
        await expect(memberNav.getByRole('button', { name: '审计日志' })).toHaveCount(0)
        await expect(memberApp.page.getByRole('heading', { name: '用户管理' })).toHaveCount(0)
      } finally {
        await memberApp.electronApp.close()
      }

      // 停用：the account dies with its sessions and can no longer sign in.
      await openRowActions(adminApp.page, memberIdentity.email)
      await adminApp.page.getByRole('menuitem', { name: '停用', exact: true }).click()
      const disableDialog = adminApp.page.getByRole('dialog', { name: `停用 ${memberDisplayName}` })
      await expect(disableDialog).toBeVisible()
      await disableDialog.getByRole('button', { name: '停用账号' }).click()
      await expect(memberRow.getByText('已停用')).toBeVisible()
      await expect(adminApp.page.getByRole('status')).toContainText('已停用')

      const loginResponse = await fetch(
        new URL('/identity/auth/login', identityServer!.serverUrl),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: memberIdentity.email, password: chosenPassword })
        }
      )
      expect(loginResponse.status).toBe(403)
      expect(((await loginResponse.json()) as { error: string }).error).toBe('account_disabled')
    } finally {
      await adminApp.electronApp.close()
    }
  } finally {
    await rm(adminUserDataDir, { recursive: true, force: true })
    await rm(memberUserDataDir, { recursive: true, force: true })
  }
})

test('Admin completes the remaining governance actions: role, email, reset, delete', async () => {
  test.setTimeout(150_000)
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const subjectIdentity = uniqueIdentity('gov-actions')
  const subjectDisplayName = `剩余动作 ${uniqueTag(subjectIdentity)}`
  const nextEmail = subjectIdentity.email.replace('gov-actions', 'gov-actions-renamed')
  const nextInitialPassword = 'rotated horse battery staple'
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-admin-governance-actions-'))

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['zh-CN'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      await signIn(launched.page, identityServer!.adminEmail, identityServer!.adminPassword)
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()
      await openUserManagementSection(launched.page)
      await createAccountThroughUi(launched.page, subjectIdentity, subjectDisplayName)

      const search = launched.page.getByLabel('搜索（邮箱或显示名）')
      await search.fill(subjectIdentity.email)
      const subjectRow = launched.page
        .getByRole('list', { name: '用户列表' })
        .getByRole('listitem')
        .filter({ hasText: subjectIdentity.email })
      await expect(subjectRow).toBeVisible()

      // 调角色：member → admin → member（E2E 管理员保持活跃，末位保护不触发）。
      const roleSelect = subjectRow.getByRole('combobox', {
        name: `更改 ${subjectDisplayName} 的角色`
      })
      await roleSelect.click()
      await launched.page.getByRole('option', { name: '管理员' }).click()
      await expect(launched.page.getByRole('status')).toContainText('角色已改为 管理员')
      await expect(subjectRow.getByText('管理员')).toBeVisible()
      await roleSelect.click()
      await launched.page.getByRole('option', { name: '成员' }).click()
      await expect(launched.page.getByRole('status')).toContainText('角色已改为 成员')

      // 改 email：the row reflects the new unique login identifier.
      await openRowActions(launched.page, subjectIdentity.email)
      await launched.page.getByRole('menuitem', { name: '改登录邮箱' }).click()
      const emailDialog = launched.page.getByRole('dialog', {
        name: `修改 ${subjectDisplayName} 的登录邮箱`
      })
      await emailDialog.getByLabel('新登录邮箱').fill(nextEmail)
      await emailDialog.getByRole('button', { name: '保存邮箱' }).click()
      await expect(launched.page.getByRole('status')).toContainText(nextEmail)

      // 重置密码：the raw API confirms the new initial password forces a change.
      await search.fill(nextEmail)
      await expect(
        launched.page
          .getByRole('list', { name: '用户列表' })
          .getByRole('listitem')
          .filter({ hasText: nextEmail })
      ).toBeVisible()
      await openRowActions(launched.page, nextEmail)
      await launched.page.getByRole('menuitem', { name: '重置密码' }).click()
      const resetDialog = launched.page.getByRole('dialog', {
        name: `重置 ${subjectDisplayName} 的密码`
      })
      await resetDialog.getByLabel('新初始密码').fill(nextInitialPassword)
      await resetDialog.getByRole('button', { name: '重置密码' }).click()
      await expect(launched.page.getByRole('status')).toContainText('已重置')

      const grant = await loginOutsideDesktop(identityServer!, {
        email: nextEmail,
        password: nextInitialPassword
      })
      expect(grant.user.must_change_password).toBe(true)

      // 删号：the raw login above marks the account as having signed in, so the
      // contract refuses its deletion with an explicit error in the dialog.
      await openRowActions(launched.page, nextEmail)
      await launched.page.getByRole('menuitem', { name: '删除', exact: true }).click()
      const refusedDialog = launched.page.getByRole('dialog', {
        name: `删除 ${subjectDisplayName}`
      })
      await refusedDialog.getByRole('button', { name: '删除账号' }).click()
      await expect(refusedDialog.getByRole('alert')).toContainText('不能删除')
      await refusedDialog.getByRole('button', { name: '取消', exact: true }).click()

      // A never-logged-in account disappears when deleted.
      const deletableIdentity = uniqueIdentity('gov-deletable')
      const deletableName = `删除对象 ${uniqueTag(deletableIdentity)}`
      await createTeamUser(identityServer!, deletableIdentity, deletableName)
      await search.fill(deletableIdentity.email)
      await expect(
        launched.page
          .getByRole('list', { name: '用户列表' })
          .getByRole('listitem')
          .filter({ hasText: deletableIdentity.email })
      ).toBeVisible()
      await openRowActions(launched.page, deletableIdentity.email)
      await launched.page.getByRole('menuitem', { name: '删除', exact: true }).click()
      const deleteDialog = launched.page.getByRole('dialog', { name: `删除 ${deletableName}` })
      await deleteDialog.getByRole('button', { name: '删除账号' }).click()
      await expect(launched.page.getByRole('status')).toContainText('已删除')
      await expect(
        launched.page
          .getByRole('list', { name: '用户列表' })
          .getByRole('listitem')
          .filter({ hasText: deletableIdentity.email })
      ).toHaveCount(0)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('the management list pages through the full directory and search narrows it', async () => {
  test.setTimeout(150_000)
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  // 21 fresh accounts guarantee a second page regardless of suite-wide seeding.
  const haystackIdentity = uniqueIdentity('gov-page')
  for (let index = 0; index < 21; index += 1) {
    await createTeamUser(
      identityServer!,
      {
        email: `${haystackIdentity.email.replace('@', `-${index}@`)}`,
        password: haystackIdentity.password
      },
      `分页账号 ${uniqueTag(haystackIdentity)} ${index}`
    )
  }

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-admin-governance-paging-'))
  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['zh-CN'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      await signIn(launched.page, identityServer!.adminEmail, identityServer!.adminPassword)
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()
      await openUserManagementSection(launched.page)

      const roster = launched.page.getByRole('list', { name: '用户列表' })
      const listItems = roster.getByRole('listitem')
      await expect(listItems.first()).toBeVisible()
      expect(await listItems.count()).toBe(20)
      await expect(launched.page.getByText(/第 1 \/ \d+ 页 · 共 \d+ 个账号/)).toBeVisible()
      await expect(launched.page.getByRole('button', { name: '上一页' })).toBeDisabled()
      const nextPage = launched.page.getByRole('button', { name: '下一页' })
      await expect(nextPage).toBeEnabled()
      await nextPage.click()
      await expect(launched.page.getByText(/第 2 \/ \d+ 页/)).toBeVisible()
      const secondPageCount = await listItems.count()
      expect(secondPageCount).toBeGreaterThan(0)
      expect(secondPageCount).toBeLessThanOrEqual(20)
      await expect(launched.page.getByRole('button', { name: '上一页' })).toBeEnabled()

      // 搜索 narrows the full directory to the matching account wherever it pages.
      await launched.page
        .getByLabel('搜索（邮箱或显示名）')
        .fill(`分页账号 ${uniqueTag(haystackIdentity)} 7`)
      await expect(listItems).toHaveCount(1)
      await expect(listItems.first()).toContainText('分页账号')
      await expect(launched.page.getByText(/共 1 个账号/)).toBeVisible()
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('the audit log lists governance events, paginates, and exports a local CSV file', async () => {
  test.setTimeout(150_000)
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const auditedIdentity = uniqueIdentity('gov-audit')
  const auditedName = `审计对象 ${uniqueTag(auditedIdentity)}`
  const exportDir = await mkdtemp(join(tmpdir(), 'nevix-audit-export-'))
  const exportPath = join(exportDir, 'audit-export.csv')
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-admin-audit-'))

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['zh-CN'],
      serverUrl: identityServer!.serverUrl,
      environment: { NEVIX_TEST_AUDIT_LOG_EXPORT_PATH: exportPath }
    })
    try {
      await signIn(launched.page, identityServer!.adminEmail, identityServer!.adminPassword)
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()

      // A governance action the audit trail must show.
      await openUserManagementSection(launched.page)
      await createAccountThroughUi(launched.page, auditedIdentity, auditedName)

      await launched.page
        .getByRole('navigation', { name: '设置' })
        .getByRole('button', { name: '审计日志' })
        .click()
      await expect(launched.page.getByRole('heading', { name: '审计日志' })).toBeVisible()

      const entries = launched.page.getByRole('list', { name: '审计条目' })
      const createdEntry = entries.getByRole('listitem').filter({ hasText: '建号' }).first()
      await expect(createdEntry).toBeVisible()
      await expect(createdEntry).toContainText(auditedName)
      await expect(createdEntry).toContainText('e2e.admin')
      await expect(launched.page.getByText(/第 1 \/ \d+ 页 · 共 \d+ 条/)).toBeVisible()

      await launched.page.getByRole('button', { name: '导出 CSV' }).click()
      await expect(launched.page.getByRole('status')).toContainText('已导出')

      const csv = await readFile(exportPath, 'utf8')
      expect(csv).toContain('时间,操作者,动作,对象,详情')
      expect(csv).toContain('建号')
      expect(csv).toContain(auditedIdentity.email)
      expect(csv.endsWith('\r\n')).toBe(true)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await rm(exportDir, { recursive: true, force: true })
  }
})

test('an audit export in flight blocks leaving the Settings Page and the ordinary close', async () => {
  test.setTimeout(120_000)
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-admin-close-guard-'))

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['zh-CN'],
      serverUrl: identityServer!.serverUrl,
      // The harness-only cancel delay holds the export in flight so its leave
      // semantics become observable without racing the real dialog.
      environment: { NEVIX_TEST_AUDIT_LOG_CANCEL_DELAY_MS: '4000' }
    })
    try {
      await signIn(launched.page, identityServer!.adminEmail, identityServer!.adminPassword)
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()
      await openSettingsFromUserMenu(launched.page)
      await launched.page
        .getByRole('navigation', { name: '设置' })
        .getByRole('button', { name: '审计日志' })
        .click()
      await expect(launched.page.getByRole('heading', { name: '审计日志' })).toBeVisible()
      await expect(launched.page.getByRole('button', { name: '导出 CSV' })).toBeEnabled()

      await launched.page.getByRole('button', { name: '导出 CSV' }).click()

      // While the export runs, section navigation and the window close are denied.
      await expect(launched.page.getByRole('button', { name: '返回应用' })).toBeDisabled()
      await requestOrdinaryWindowClose(launched.electronApp)
      await expectMainWindowCount(launched.electronApp, 1)
      await expect(launched.page.getByRole('heading', { name: '审计日志' })).toBeVisible()

      // The delayed export finishes cancelled; navigation recovers.
      await expect(launched.page.getByRole('button', { name: '导出 CSV' })).toBeEnabled({
        timeout: 15_000
      })
      await expect(launched.page.getByRole('button', { name: '返回应用' })).toBeEnabled()
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})
