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
 * Object Storage Settings through the real desktop and the real Go server
 * (issue #218): the Admin sees the not-configured surface, the create
 * command demands exact-action reauthentication, and — because the E2E
 * server runs plain HTTP, exactly like a deployment that skipped the
 * trusted HTTPS marker — the proof endpoint itself answers
 * secure_transport_required and the desktop surfaces the stable advice.
 * Members see only the unavailable advice.
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

test('the Admin reaches the Object Storage proof gate and the server refuses non-HTTPS transport', async () => {
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
      const storage = page.getByRole('region', { name: '对象存储' })
      await expect(storage.getByText('尚未配置对象存储。')).toBeVisible()

      await storage.getByLabel('Region').fill('oss-cn-hangzhou')
      await storage.getByLabel('Bucket').fill('private-bucket')
      await storage.getByLabel('Access Key ID').fill('test-access-key-id')
      await storage.getByLabel('Secret Access Key').fill('test-secret-access-key')
      await expect(storage.getByRole('button', { name: '保存并验证' })).toBeEnabled()
      await storage.getByLabel('Secret Access Key').press('Enter')
      const reauthDialog = page.getByRole('dialog', { name: '确认当前密码' })
      await expect(reauthDialog.getByText('首次配置对象存储连接', { exact: true })).toBeVisible()
      await reauthDialog.getByLabel('当前密码').fill(identityServer!.adminPassword)
      await reauthDialog.getByRole('button', { name: '验证并继续' }).click()
      await expect(reauthDialog.getByText(/HTTPS/)).toBeVisible()
      await reauthDialog.getByRole('button', { name: '取消' }).click()
      await expect(reauthDialog).toHaveCount(0)
      await expect(storage.getByText('尚未配置对象存储。')).toBeVisible()

      // Leave the shared Settings harness clean: a failed proof intentionally
      // preserves the draft, so the test clears it before closing the window.
      await storage.getByLabel('Region').fill('')
      await storage.getByLabel('Bucket').fill('')
      await storage.getByLabel('Access Key ID').fill('')
      await storage.getByLabel('Secret Access Key').fill('')
      await expect(storage.getByRole('button', { name: '保存并验证' })).toBeDisabled()
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
        action: 'object_storage_connection.create',
        password: identityServer!.adminPassword
      })
    })
    expect(proof.status).toBe(400)
    expect(((await proof.json()) as { error: string }).error).toBe('secure_transport_required')
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('a Member sees Object Storage unavailable advice with no management commands', async () => {
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
      const storage = page.getByRole('region', { name: '对象存储' })
      await expect(storage.getByText('对象存储不可用，请联系管理员。')).toBeVisible()
      await expect(storage.getByRole('button')).toHaveCount(0)
    } finally {
      await app.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})
