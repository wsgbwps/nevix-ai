import { expect, test } from '@playwright/test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'
import {
  createAuthUser,
  deleteAuthUser,
  readAuthHarnessConfig,
  uniqueAuthIdentity
} from './helpers/supabase-auth'

const authHarness = readAuthHarnessConfig()
const SESSION_FILE_NAME = 'authentication-session.enc'

/**
 * Regression: a sign-up submission used to leave the provider SIGNED_OUT suppression flag set
 * forever, so a Session revoked while the application was running kept the authenticated shell
 * on screen. The flow below reproduces that exact history — sign-up attempt, then password
 * sign-in — before the runtime revocation arrives.
 */
test('a Session revoked at runtime after a sign-up attempt still returns to the login boundary', async () => {
  test.setTimeout(120_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('runtime-revocation')
  const userId = await createAuthUser(authHarness, identity, true)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-runtime-revocation-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      // A repeat registration is existence-neutral, so the sign-up submission succeeds visibly.
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await launched.page.getByRole('button', { name: 'Create account' }).click()
      await launched.page.getByLabel('Email').fill(identity.email)
      await launched.page.getByLabel('Password').fill(identity.password)
      await launched.page.getByRole('button', { name: 'Create account' }).click()
      await expect(launched.page.getByRole('heading', { name: 'Check your email' })).toBeVisible()

      await launched.page.getByRole('button', { name: 'Go to sign in' }).click()
      await launched.page.getByLabel('Email').fill(identity.email)
      await launched.page.getByLabel('Password').fill(identity.password)
      await launched.page.getByRole('button', { name: 'Sign in' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()

      // The provider rejects the next refresh the way GoTrue reports a revoked Refresh Token.
      await launched.page.route('**/auth/v1/token?grant_type=refresh_token', (route) =>
        route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            error_code: 'refresh_token_not_found',
            msg: 'Invalid Refresh Token: Refresh Token Not Found'
          })
        })
      )

      // Faking Date past the JWT lifetime makes the next real auto-refresh tick treat the access
      // token as expired, so the rejected refresh is terminal and emits a runtime SIGNED_OUT.
      await launched.page.clock.install()
      await launched.page.clock.fastForward(3_700_000)

      await expect(
        launched.page.getByText('Your session is no longer valid. Sign in again.')
      ).toBeVisible({ timeout: 60_000 })
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toHaveCount(0)
      await expect.poll(() => fileExists(sessionPath)).toBe(false)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, userId)
  }
})

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
