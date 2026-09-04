import { expect, test, type Locator } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'
import { createTeamUser, readIdentityServerConfig, uniqueIdentity } from './helpers/identity-server'

const identityServer = readIdentityServerConfig()

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
    test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
    if (!identityServer) return

    const identity = uniqueIdentity('password-visibility')
    await createTeamUser(identityServer, identity)
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-password-visibility-'))

    try {
      const launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['en-US'],
        serverUrl: identityServer!.serverUrl
      })

      try {
        const loginPassword = launched.page.getByLabel('Password', { exact: true })
        await expect(loginPassword).toHaveAttribute('type', 'password')
        await loginPassword.fill(NON_SECRET_VISIBILITY_MARKER)
        await visibilityToggle(loginPassword, 'Show entered value').click()
        await expect(loginPassword).toHaveAttribute('type', 'text')

        // The forced first-login change form carries the remaining password fields.
        await launched.page.getByLabel('Email').fill(identity.email)
        await loginPassword.fill(identity.password)
        await launched.page.getByRole('button', { name: 'Sign in' }).click()
        const initialPassword = launched.page.getByLabel('Initial password', { exact: true })
        const newPassword = launched.page.getByLabel('New password', { exact: true })
        const confirmPassword = launched.page.getByLabel('Confirm new password')
        await expect(initialPassword).toHaveAttribute('type', 'password')
        await expect(newPassword).toHaveAttribute('type', 'password')
        await expect(confirmPassword).toHaveAttribute('type', 'password')
        await initialPassword.fill(NON_SECRET_VISIBILITY_MARKER)
        await newPassword.fill(NON_SECRET_VISIBILITY_MARKER)
        await confirmPassword.fill(NON_SECRET_VISIBILITY_MARKER)

        await visibilityToggle(initialPassword, 'Show entered value').click()
        await expect(initialPassword).toHaveAttribute('type', 'text')
        await expect(newPassword).toHaveAttribute('type', 'password')
        await expect(confirmPassword).toHaveAttribute('type', 'password')

        await visibilityToggle(newPassword, 'Show entered value').click()
        await expect(initialPassword).toHaveAttribute('type', 'text')
        await expect(newPassword).toHaveAttribute('type', 'text')
        await expect(confirmPassword).toHaveAttribute('type', 'password')

        await visibilityToggle(confirmPassword, 'Show entered value').click()
        await expect(initialPassword).toHaveAttribute('type', 'text')
        await expect(newPassword).toHaveAttribute('type', 'text')
        await expect(confirmPassword).toHaveAttribute('type', 'text')

        // Leaving the change boundary remounts the login form remasked and cleared.
        await launched.page.getByRole('button', { name: 'Sign out without changing' }).click()
        await expect(loginPassword).toHaveAttribute('type', 'password')
        await expect(loginPassword).toHaveValue('')

        // Re-entering the change boundary remounts its fields remasked and cleared as well.
        await loginPassword.fill(identity.password)
        await launched.page.getByRole('button', { name: 'Sign in' }).click()
        await expect(initialPassword).toHaveAttribute('type', 'password')
        await expect(initialPassword).toHaveValue('')
        await expect(newPassword).toHaveAttribute('type', 'password')
        await expect(newPassword).toHaveValue('')
        await expect(confirmPassword).toHaveAttribute('type', 'password')
        await expect(confirmPassword).toHaveValue('')
        await launched.page.getByRole('button', { name: 'Sign out without changing' }).click()

        await loginPassword.fill(NON_SECRET_VISIBILITY_MARKER)
        await visibilityToggle(loginPassword, 'Show entered value').click()
        await launched.electronApp.evaluate(({ app, BrowserWindow }) => {
          app.focus({ steal: true })
          const window = BrowserWindow.getAllWindows()[0]
          window?.show()
          window?.focus()
        })
        await launched.page.waitForTimeout(250)
        await launched.electronApp.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]
          if (!window) throw new Error('Expected the main BrowserWindow to exist')

          if (window.isFocused()) {
            window.blur()
            return
          }

          // Some automated macOS sessions deny focus stealing even after app.focus/show/focus.
          // Emitting the same Electron boundary keeps this test on the renderer remasking contract.
          window.emit('blur')
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
        const usedHeadlessMinimizeFallback = await launched.electronApp.evaluate(
          ({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0]
            if (!window) {
              throw new Error('Expected the main BrowserWindow to exist')
            }

            window.minimize()

            // A headless Linux session may have no window manager, so the native minimize
            // request cannot change window state. Emitting the same Electron event keeps that
            // environment focused on the main-process deactivation bridge.
            const requiresFallback =
              process.platform === 'linux' && Boolean(process.env.CI) && !window.isMinimized()
            if (requiresFallback) {
              window.emit('minimize')
            }

            return requiresFallback
          }
        )
        if (!usedHeadlessMinimizeFallback) {
          await expect
            .poll(() =>
              launched.electronApp.evaluate(
                ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized() ?? false
              )
            )
            .toBe(true)
        }
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
