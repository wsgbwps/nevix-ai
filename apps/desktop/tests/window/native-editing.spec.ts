import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'
import {
  createAuthUser,
  deleteAuthUser,
  readAuthHarnessConfig,
  uniqueAuthIdentity
} from '../auth/helpers/supabase-auth'
import {
  readMailpitHarnessConfig,
  readMailpitMessageIds,
  waitForRegistrationMessage
} from '../auth/helpers/mailpit'

const authHarness = readAuthHarnessConfig()
const mailpitHarness = readMailpitHarnessConfig()
const editModifier = process.platform === 'darwin' ? 'Meta' : 'Control'

interface NativeMenuItemSnapshot {
  readonly role: string
  readonly enabled: boolean
}

async function captureContextMenuPopups(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ Menu }) => {
    const probe = globalThis as {
      __nevixNativeMenuSnapshots?: Array<Array<{ role: string; enabled: boolean }>>
    }
    probe.__nevixNativeMenuSnapshots = []

    Menu.prototype.popup = function (): void {
      probe.__nevixNativeMenuSnapshots?.push(
        this.items
          .filter((item) => item.type !== 'separator')
          .map((item) => ({ role: item.role, enabled: item.enabled }))
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
          __nevixNativeMenuSnapshots?: Array<Array<{ role: string; enabled: boolean }>>
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

test('editable controls expose only native edit roles and standard accelerators change their value', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SUPABASE_URL,
    'requires the configured build produced by the Auth test command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-native-editing-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

    try {
      await captureContextMenuPopups(launched.electronApp)

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
        { role: 'undo', enabled: true },
        { role: 'cut', enabled: true },
        { role: 'copy', enabled: true },
        { role: 'paste', enabled: true },
        { role: 'delete', enabled: true },
        { role: 'selectall', enabled: true }
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

      const password = launched.page.getByLabel('Password')
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

test('Authentication password and one-time-code fields accept native paste shortcuts', async () => {
  test.setTimeout(90_000)
  test.skip(!authHarness || !mailpitHarness, 'requires disposable Supabase Auth and Mailpit')
  if (!authHarness || !mailpitHarness) return

  const signupIdentity = uniqueAuthIdentity('native-editing-signup')
  const recoveryIdentity = uniqueAuthIdentity('native-editing-recovery')
  const recoveryUserId = await createAuthUser(authHarness, recoveryIdentity, true)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-native-editing-auth-'))

  try {
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
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, recoveryUserId)
  }
})
