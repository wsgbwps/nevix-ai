import { expect, test, type Locator } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'

// This value is deliberately not an authentication credential. It is safe if Playwright includes
// it in a failure message or screenshot while proving that remasking does not clear the field.
const NON_SECRET_VISIBILITY_MARKER = 'not a real password'

function visibilityToggle(
  passwordInput: Locator,
  name: 'Show entered value' | 'Hide entered value'
): Locator {
  return passwordInput.locator('..').getByRole('button', { name })
}

test(
  'password fields reveal independently and remask at every renderer safety boundary',
  { tag: '@smoke' },
  async () => {
    test.skip(
      !process.env.NEVIX_TEST_SUPABASE_URL,
      'requires the configured build produced by the Auth test command'
    )

    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-password-visibility-'))

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

      try {
        const loginPassword = launched.page.getByLabel('Password')
        await expect(loginPassword).toHaveAttribute('type', 'password')
        await visibilityToggle(loginPassword, 'Show entered value').click()
        await expect(loginPassword).toHaveAttribute('type', 'text')

        await launched.page.getByRole('button', { name: 'Create account' }).click()

        const signupPassword = launched.page.getByLabel('Password', { exact: true })
        const confirmPassword = launched.page.getByLabel('Confirm password')
        await expect(signupPassword).toHaveAttribute('type', 'password')
        await expect(confirmPassword).toHaveAttribute('type', 'password')

        await visibilityToggle(signupPassword, 'Show entered value').click()
        await expect(signupPassword).toHaveAttribute('type', 'text')
        await expect(confirmPassword).toHaveAttribute('type', 'password')

        await visibilityToggle(confirmPassword, 'Show entered value').click()
        await expect(signupPassword).toHaveAttribute('type', 'text')
        await expect(confirmPassword).toHaveAttribute('type', 'text')

        await launched.page.getByRole('button', { name: 'Sign in instead' }).click()
        await expect(launched.page.getByLabel('Password')).toHaveAttribute('type', 'password')

        await loginPassword.fill(NON_SECRET_VISIBILITY_MARKER)
        await visibilityToggle(loginPassword, 'Show entered value').click()
        await launched.electronApp.evaluate(({ app, BrowserWindow }) => {
          app.focus({ steal: true })
          const window = BrowserWindow.getAllWindows()[0]
          window?.show()
          window?.focus()
        })
        await expect
          .poll(() =>
            launched.electronApp.evaluate(
              ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFocused() ?? false
            )
          )
          .toBe(true)
        await launched.electronApp.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.blur()
        })
        await expect(loginPassword).toHaveAttribute('type', 'password')
        await expect(loginPassword).toHaveValue(NON_SECRET_VISIBILITY_MARKER)

        await launched.electronApp.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.focus()
        })
        await visibilityToggle(loginPassword, 'Show entered value').click()
        await launched.page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden'
          })
          document.dispatchEvent(new Event('visibilitychange'))
        })
        expect(await launched.page.evaluate(() => document.visibilityState)).toBe('hidden')
        await expect(loginPassword).toHaveAttribute('type', 'password')
        await expect(loginPassword).toHaveValue(NON_SECRET_VISIBILITY_MARKER)

        await launched.page.evaluate(() => {
          Reflect.deleteProperty(document, 'visibilityState')
          document.dispatchEvent(new Event('visibilitychange'))
        })
        await visibilityToggle(loginPassword, 'Show entered value').click()
        await launched.electronApp.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.minimize()
        })
        await expect
          .poll(() =>
            launched.electronApp.evaluate(
              ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized() ?? false
            )
          )
          .toBe(true)
        await expect(loginPassword).toHaveAttribute('type', 'password')
        await expect(loginPassword).toHaveValue(NON_SECRET_VISIBILITY_MARKER)
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)
