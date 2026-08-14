import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'
import {
  createAuthUser,
  deleteAuthUser,
  readAuthHarnessConfig,
  signInOutsideDesktop,
  uniqueAuthIdentity
} from '../auth/helpers/supabase-auth'
import {
  readMailpitHarnessConfig,
  readMailpitMessageIds,
  waitForRegistrationMessage
} from '../auth/helpers/mailpit'
import {
  seedOrganizationWithMembership,
  seedProfile
} from '../organization/helpers/organization-seed'

const authHarness = readAuthHarnessConfig()
const mailpitHarness = readMailpitHarnessConfig()
const serverUrl = process.env.NEVIX_TEST_SERVER_URL
const editModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const LANGUAGE_MODE_FILE_NAME = 'language-mode.json'

interface NativeMenuItemSnapshot {
  readonly role: string
  readonly label: string
  readonly enabled: boolean
}

async function captureContextMenuPopups(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ Menu }) => {
    const probe = globalThis as {
      __nevixNativeMenuSnapshots?: Array<Array<{ role: string; label: string; enabled: boolean }>>
    }
    probe.__nevixNativeMenuSnapshots = []

    Menu.prototype.popup = function (): void {
      probe.__nevixNativeMenuSnapshots?.push(
        this.items
          .filter((item) => item.type !== 'separator')
          .map((item) => ({ role: item.role, label: item.label, enabled: item.enabled }))
      )
    }
  })
}

async function readContextMenuPopups(
  electronApp: ElectronApplication
): Promise<readonly (readonly NativeMenuItemSnapshot[])[]> {
  return electronApp.evaluate(
    () =>
      (
        globalThis as {
          __nevixNativeMenuSnapshots?: Array<
            Array<{ role: string; label: string; enabled: boolean }>
          >
        }
      ).__nevixNativeMenuSnapshots ?? []
  )
}

async function writeClipboard(electronApp: ElectronApplication, text: string): Promise<void> {
  await electronApp.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
}

async function readClipboard(electronApp: ElectronApplication): Promise<string> {
  return electronApp.evaluate(({ clipboard }) => clipboard.readText())
}

async function pasteInto(
  electronApp: ElectronApplication,
  page: Page,
  locator: Locator,
  text: string
): Promise<void> {
  await writeClipboard(electronApp, text)
  await locator.click()
  await page.keyboard.press(`${editModifier}+V`)
}

test('the app exposes only managed hidden native edit accelerators', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-native-editing-menu-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

    try {
      const applicationMenuItems = await launched.electronApp.evaluate(({ Menu }) => {
        const menu = Menu.getApplicationMenu()
        return menu?.items.map((item) => ({ role: item.role, visible: item.visible })) ?? []
      })

      expect(applicationMenuItems).toEqual([
        { role: 'undo', visible: false },
        { role: 'cut', visible: false },
        { role: 'copy', visible: false },
        { role: 'paste', visible: false },
        { role: 'delete', visible: false },
        { role: 'selectall', visible: false }
      ])
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('editable controls expose only native edit roles and standard accelerators change their value', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SUPABASE_URL,
    'requires the configured build produced by the Auth test command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-native-editing-'))
  await writeFile(
    join(userDataDir, LANGUAGE_MODE_FILE_NAME),
    JSON.stringify({ languageMode: 'en' }),
    'utf8'
  )

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['zh-CN'] })

    try {
      await captureContextMenuPopups(launched.electronApp)
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()

      await launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' }).click({
        button: 'right'
      })
      await launched.page.waitForTimeout(100)
      expect(await readContextMenuPopups(launched.electronApp)).toEqual([])

      const email = launched.page.getByLabel('Email')
      await email.click()
      await launched.page.keyboard.type('editable draft')
      await email.selectText()
      await writeClipboard(launched.electronApp, 'clipboard value')
      await email.click({ button: 'right' })

      await expect.poll(() => readContextMenuPopups(launched.electronApp)).toHaveLength(1)
      expect((await readContextMenuPopups(launched.electronApp))[0]).toEqual([
        { role: 'undo', label: 'Undo', enabled: true },
        { role: 'cut', label: 'Cut', enabled: true },
        { role: 'copy', label: 'Copy', enabled: true },
        { role: 'paste', label: 'Paste', enabled: true },
        { role: 'delete', label: 'Delete', enabled: true },
        { role: 'selectall', label: 'Select All', enabled: true }
      ])

      const pastedValue = 'Native editing test value 42'
      await email.fill('')
      await pasteInto(launched.electronApp, launched.page, email, pastedValue)
      await expect(email).toHaveValue(pastedValue)

      await launched.page.keyboard.press(`${editModifier}+Z`)
      await expect(email).toHaveValue('')
      await launched.page.keyboard.press(`${editModifier}+V`)
      await launched.page.keyboard.press(`${editModifier}+A`)
      await launched.page.keyboard.press(`${editModifier}+C`)
      expect(await readClipboard(launched.electronApp)).toBe(pastedValue)

      await launched.page.keyboard.press(`${editModifier}+X`)
      await expect(email).toHaveValue('')
      expect(await readClipboard(launched.electronApp)).toBe(pastedValue)

      await launched.page.keyboard.press(`${editModifier}+V`)
      await launched.page.keyboard.press(`${editModifier}+A`)
      await launched.page.keyboard.press('Backspace')
      await expect(email).toHaveValue('')

      await launched.page.evaluate(() =>
        window.api.invoke('language:set-language-mode', { languageMode: 'zh-CN' })
      )
      await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      await launched.page.getByLabel('邮箱').click({ button: 'right' })

      await expect.poll(() => readContextMenuPopups(launched.electronApp)).toHaveLength(2)
      expect(
        (await readContextMenuPopups(launched.electronApp))[1]?.map(({ role, label }) => ({
          role,
          label
        }))
      ).toEqual([
        { role: 'undo', label: '撤销' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'delete', label: '删除' },
        { role: 'selectall', label: '全选' }
      ])

      const password = launched.page.getByLabel('密码')
      await pasteInto(launched.electronApp, launched.page, password, pastedValue)
      await expect(password).toHaveValue(pastedValue)
      await launched.page.keyboard.press(`${editModifier}+A`)
      await launched.page.keyboard.press('Backspace')
      await expect(password).toHaveValue('')
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('Password and all one-time-code fields accept native paste shortcuts', async () => {
  test.setTimeout(150_000)
  if (!authHarness || !mailpitHarness || !serverUrl) {
    throw new Error(
      'Organization Invitation native-paste coverage requires the disposable E2E integration harness'
    )
  }

  const signupIdentity = uniqueAuthIdentity('native-editing-signup')
  const recoveryIdentity = uniqueAuthIdentity('native-editing-recovery')
  const ownerIdentity = uniqueAuthIdentity('native-editing-invitation-owner')
  const recoveryUserId = await createAuthUser(authHarness, recoveryIdentity, true)
  const ownerUserId = await createAuthUser(authHarness, ownerIdentity, true)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-native-editing-auth-'))

  try {
    await seedProfile(recoveryUserId, 'Native Editing Invitee')
    const organization = await seedOrganizationWithMembership(ownerUserId, {
      name: 'Native Editing Invitation Studio',
      profileDisplayName: 'Native Editing Owner'
    })
    const ownerSession = await signInOutsideDesktop(authHarness, ownerIdentity)
    const messagesBeforeInvitation = await readMailpitMessageIds(mailpitHarness)
    const invitationResponse = await fetch(
      new URL(`/identity/organizations/${organization.id}/invitations`, serverUrl),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${ownerSession.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email: recoveryIdentity.email })
      }
    )
    if (!invitationResponse.ok) {
      throw new Error(
        `Unable to create native-editing test invitation: ${invitationResponse.status}`
      )
    }
    const invitationMessage = await waitForRegistrationMessage(
      mailpitHarness,
      messagesBeforeInvitation,
      recoveryIdentity.email
    )

    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

    try {
      const loginPassword = launched.page.getByLabel('Password')
      await pasteInto(launched.electronApp, launched.page, loginPassword, recoveryIdentity.password)
      await expect(loginPassword).toHaveValue(recoveryIdentity.password)

      await launched.page.getByRole('button', { name: 'Create account' }).click()
      await launched.page.getByLabel('Email').fill(signupIdentity.email)
      const signupPassword = launched.page.getByLabel('Password', { exact: true })
      const confirmPassword = launched.page.getByLabel('Confirm password')
      await pasteInto(launched.electronApp, launched.page, signupPassword, signupIdentity.password)
      await pasteInto(launched.electronApp, launched.page, confirmPassword, signupIdentity.password)
      await expect(signupPassword).toHaveValue(signupIdentity.password)
      await expect(confirmPassword).toHaveValue(signupIdentity.password)

      const messagesBeforeSignup = await readMailpitMessageIds(mailpitHarness)
      await launched.page.getByRole('button', { name: 'Create account' }).click()
      const signupMessage = await waitForRegistrationMessage(
        mailpitHarness,
        messagesBeforeSignup,
        signupIdentity.email
      )
      const verificationCode = launched.page.getByLabel('Verification code')
      await pasteInto(launched.electronApp, launched.page, verificationCode, signupMessage.code)
      await expect(verificationCode).toHaveValue(signupMessage.code)

      await launched.page.getByRole('button', { name: 'Sign in' }).click()
      await launched.page.getByRole('button', { name: 'Forgot password?' }).click()
      const messagesBeforeRecovery = await readMailpitMessageIds(mailpitHarness)
      await launched.page.getByLabel('Email').fill(recoveryIdentity.email)
      await launched.page.waitForTimeout(1_100)
      await launched.page.getByRole('button', { name: 'Send recovery code' }).click()
      const recoveryMessage = await waitForRegistrationMessage(
        mailpitHarness,
        messagesBeforeRecovery,
        recoveryIdentity.email
      )
      const recoveryCode = launched.page.getByLabel('Recovery code')
      await pasteInto(launched.electronApp, launched.page, recoveryCode, recoveryMessage.code)
      await expect(recoveryCode).toHaveValue(recoveryMessage.code)

      await launched.page.getByRole('button', { name: 'Verify code' }).click()
      const recoveryPassword = launched.page.getByLabel('New password')
      const replacementPassword = 'Replacement password 42'
      await pasteInto(launched.electronApp, launched.page, recoveryPassword, replacementPassword)
      await expect(recoveryPassword).toHaveValue(replacementPassword)

      await launched.page.getByRole('button', { name: 'Update password' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await launched.page.getByLabel('Email').fill(recoveryIdentity.email)
      await launched.page.getByLabel('Password').fill(replacementPassword)
      await launched.page.getByRole('button', { name: 'Sign in' }).click()

      await expect(
        launched.page.getByRole('heading', { name: 'Select an organization' })
      ).toBeVisible()
      await launched.page.getByRole('button', { name: 'Accept' }).click()
      const invitationCode = launched.page.getByRole('textbox', { name: 'Invitation code' })
      await expect(invitationCode).toBeVisible()
      await pasteInto(launched.electronApp, launched.page, invitationCode, invitationMessage.code)
      await expect(invitationCode).toHaveValue(invitationMessage.code)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, recoveryUserId)
    await deleteAuthUser(authHarness, ownerUserId)
  }
})
