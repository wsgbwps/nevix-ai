import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp, openSettingsFromUserMenu } from '../helpers/electron-app'
import {
  createStableTeamUser,
  readIdentityServerConfig,
  uniqueIdentity
} from '../auth/helpers/identity-server'

const identityServer = readIdentityServerConfig()

/**
 * AI Creation Settings through the real desktop and the real Go server
 * (issue #157): the Admin sees the not-configured surface, the configure
 * command demands exact-action reauthentication, and — because the E2E
 * server runs plain HTTP, exactly like a deployment that skipped the
 * trusted HTTPS marker — the proof endpoint itself answers
 * secure_transport_required and the desktop surfaces the stable advice.
 * Members see the per-media status-only card.
 */

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('邮箱').fill(email)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

async function openAiCreationSection(page: Page): Promise<void> {
  await openSettingsFromUserMenu(page)
  await page
    .getByRole('navigation', { name: '设置' })
    .getByRole('button', { name: 'AI 创作' })
    .click()
  await expect(page.getByRole('heading', { name: 'AI 创作', exact: true })).toBeVisible()
}

test('the Admin reaches the proof gate and the server refuses non-HTTPS transport', async () => {
  test.setTimeout(120_000)
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-admin-ai-creation-'))
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

      await openAiCreationSection(page)
      await expect(page.getByText('尚未配置 AI 供应商连接')).toBeVisible()

      // Requesting configuration demands the exact-action confirmation
      // first; with the confirmation as the only open modal, its failure
      // surfaces stably. The disposable E2E server is plain HTTP, so the
      // proof endpoint refuses with secure_transport_required and the
      // dialog shows the stable guidance — no key was entered, no proof
      // consumed, and the connection stays unconfigured.
      await page.getByRole('button', { name: '配置连接' }).click()
      const reauthDialog = page.getByRole('dialog', { name: '确认当前密码' })
      await expect(reauthDialog.getByText('首次配置供应商连接', { exact: true })).toBeVisible()
      await reauthDialog.getByLabel('当前密码').fill(identityServer!.adminPassword)
      await reauthDialog.getByRole('button', { name: '验证并继续' }).click()
      await expect(reauthDialog.getByText(/HTTPS/)).toBeVisible()
      await reauthDialog.getByRole('button', { name: '取消' }).click()
      await expect(reauthDialog).toHaveCount(0)
      await expect(page.getByText('尚未配置 AI 供应商连接')).toBeVisible()
    } finally {
      await app.electronApp.close()
    }

    // The proof endpoint itself refuses the disposable server's plain HTTP
    // transport — the same refusal the dialog would surface — proven here
    // against the real Go server without depending on the renderer.
    const login = await fetch(new URL('/identity/auth/login', identityServer!.serverUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: identityServer!.adminEmail,
        password: identityServer!.adminPassword
      })
    })
    const loginBody = (await login.json()) as { token?: string }
    expect(typeof loginBody.token).toBe('string')
    const proof = await fetch(new URL('/identity/admin/reauth/proofs', identityServer!.serverUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginBody.token}`
      },
      body: JSON.stringify({
        action: 'provider_connection.create',
        password: identityServer!.adminPassword
      })
    })
    expect(proof.status).toBe(400)
    expect(((await proof.json()) as { error: string }).error).toBe('secure_transport_required')
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('a Member sees per-media status and advice only, with no management commands', async () => {
  test.setTimeout(120_000)
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const identity = uniqueIdentity('member-ai-creation-status')
  await createStableTeamUser(identityServer, identity)

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-member-ai-creation-'))
  try {
    const app = await launchTestApp({
      userDataDir,
      systemLanguages: ['zh-CN'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      const page = app.page
      await signIn(page, identity.email, identity.password)
      await expect(page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()

      await openAiCreationSection(page)
      await expect(page.getByText('图片生成', { exact: true })).toBeVisible()
      await expect(page.getByText('视频生成', { exact: true })).toBeVisible()
      await expect(page.getByText('不可用').first()).toBeVisible()
      await expect(page.getByText('请联系管理员处理。')).toHaveCount(2)
      await expect(page.getByRole('button', { name: '配置连接' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '暂停' })).toHaveCount(0)
    } finally {
      await app.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})
