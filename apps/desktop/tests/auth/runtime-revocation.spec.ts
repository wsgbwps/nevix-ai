import { expect, test } from '@playwright/test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'
import {
  createStableTeamUser,
  readIdentityServerConfig,
  resetTeamUserPassword,
  uniqueIdentity
} from './helpers/identity-server'

const identityServer = readIdentityServerConfig()
const SESSION_FILE_NAME = 'authentication-session.enc'

/**
 * Without the push channel (a later slice), a session revoked while the application runs is
 * discovered on the next contact with the server: a relaunch verifies the stored token against
 * /me, clears the rejected credentials, and lands on the login boundary.
 */
test('a session revoked at runtime is cleared on the next launch and cannot restore the shell', async () => {
  test.setTimeout(120_000)
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const identity = uniqueIdentity('runtime-revocation')
  const user = await createStableTeamUser(identityServer, identity)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-runtime-revocation-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await launched.page.getByLabel('Email').fill(identity.email)
      await launched.page.getByLabel('Password').fill(identity.password)
      await launched.page.getByRole('button', { name: 'Sign in' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      await expect.poll(() => fileExists(sessionPath)).toBe(true)

      // An Admin password reset revokes every session of the user while the app stays open.
      await resetTeamUserPassword(identityServer, user.id, 'revoked horse battery staple')

      // Nothing polls in this slice, so the open shell stays as-is until the next contact.
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
    } finally {
      await launched.electronApp.close()
    }

    const relaunched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await expect(
        relaunched.page.getByText('Your session is no longer valid. Sign in again.')
      ).toBeVisible()
      await expect(
        relaunched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expect(
        relaunched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toHaveCount(0)
      await expect.poll(() => fileExists(sessionPath)).toBe(false)
    } finally {
      await relaunched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
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
