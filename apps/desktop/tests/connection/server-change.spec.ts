import { expect, test } from '@playwright/test'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hasSecurePersistenceBackend,
  launchTestApp,
  openSettingsFromUserMenu
} from '../helpers/electron-app'
import {
  createStableTeamUser,
  readIdentityServerConfig,
  readOpenServerConfig,
  uniqueIdentity
} from '../auth/helpers/identity-server'

const identityServer = readIdentityServerConfig()
// The open claim server stays empty for the whole suite: the deleted
// orchestration-only claim specs no longer consume it, so switching a signed-in
// device onto it deterministically lands on the first-admin claim boundary.
const openServer = readOpenServerConfig()
const SESSION_FILE_NAME = 'authentication-session.enc'

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

test('changing the configured server while signed in clears the session and reloads into the new boundary', async () => {
  test.skip(
    !identityServer || !openServer,
    'requires the identity server and empty open-claim server stack produced by the E2E command'
  )

  const identity = uniqueIdentity('server-change')
  await createStableTeamUser(identityServer!, identity)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-connection-change-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      await launched.page.getByLabel('Email').fill(identity.email)
      await launched.page.getByLabel('Password').fill(identity.password)
      await launched.page.getByRole('button', { name: 'Sign in' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      // The stored-envelope assertions need a backend that actually persists
      // sessions; CI-forced basic_text stores nothing by design, where the
      // reload-to-claim-boundary assertions below still prove the flow.
      const hasSecureBackend = await hasSecurePersistenceBackend(launched.electronApp)
      if (hasSecureBackend) {
        await expect.poll(() => fileExists(sessionPath)).toBe(true)
      }

      // The Settings connection section rewrites the configured server URL;
      // saving must clear the stored session and reload the renderer, so the
      // fresh runtime binds to the new server instead of mixing two of them.
      await openSettingsFromUserMenu(launched.page)
      await launched.page.getByRole('button', { name: 'Server connection' }).click()
      await launched.page.getByLabel('Server address').fill(openServer!.serverUrl)
      await launched.page.getByRole('button', { name: 'Test connection' }).click()
      await expect(launched.page.getByTestId('connection-probe-reachable')).toBeVisible()
      await launched.page
        .getByRole('button', { name: 'Save and continue' })
        .click({ noWaitAfter: true })

      // The same window has reloaded against the still-empty new server: no
      // stale shell, no stored session, and the claim boundary answers.
      await expect(launched.page.getByRole('heading', { name: 'Initialize Nevix AI' })).toBeVisible(
        { timeout: 20_000 }
      )
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toHaveCount(0)
      if (hasSecureBackend) {
        expect(await fileExists(sessionPath)).toBe(false)
      }
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})
