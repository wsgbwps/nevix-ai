import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp, signOutFromUserMenu } from '../helpers/electron-app'
import { readSetupServerConfig } from './helpers/identity-server'

const setupServer = readSetupServerConfig()

const FIRST_ADMIN_EMAIL = 'first.admin@nevix-e2e.test'
const FIRST_ADMIN_PASSWORD = 'correct horse battery staple'

test('the first-run wizard initializes an empty server; later devices see only sign-in', async () => {
  test.skip(!setupServer, 'requires the disposable empty-instance server built by the E2E command')
  if (!setupServer) return

  const firstDeviceDir = await mkdtemp(join(tmpdir(), 'nevix-auth-setup-wizard-'))
  try {
    const firstDevice = await launchTestApp({
      userDataDir: firstDeviceDir,
      systemLanguages: ['en-US'],
      serverUrl: setupServer!.serverUrl
    })

    try {
      // The empty instance swaps the login boundary for the first-run wizard.
      await expect(
        firstDevice.page.getByRole('heading', { name: 'Initialize Nevix AI' })
      ).toBeVisible()
      await expect(
        firstDevice.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toHaveCount(0)

      await firstDevice.page.getByLabel('Email').fill(FIRST_ADMIN_EMAIL)
      await firstDevice.page.getByLabel('Password', { exact: true }).fill(FIRST_ADMIN_PASSWORD)
      await firstDevice.page.getByLabel('Confirm password').fill(FIRST_ADMIN_PASSWORD)
      await firstDevice.page.getByLabel('Display name (optional)').fill('First Admin')
      // A protected deployment validates the code: a wrong one answers the
      // dedicated error and the wizard stays up.
      await firstDevice.page.getByLabel('Setup code').fill('00000000')
      await firstDevice.page
        .getByRole('button', { name: 'Create administrator and continue' })
        .click()
      await expect(
        firstDevice.page.getByText(
          'The setup code is not valid. Check the latest code in the server operations log.'
        )
      ).toBeVisible()
      await expect(
        firstDevice.page.getByRole('heading', { name: 'Initialize Nevix AI' })
      ).toBeVisible()

      await firstDevice.page.getByLabel('Setup code').fill(setupServer!.setupCode)
      await firstDevice.page
        .getByRole('button', { name: 'Create administrator and continue' })
        .click()

      // The initialize response carries a working admin session: the shell opens
      // directly, with no forced first-login password change in between.
      await expect(
        firstDevice.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      await expect(
        firstDevice.page.getByRole('heading', { name: 'Set a new password' })
      ).toHaveCount(0)

      // Ending the session on the initializing device lands on the ordinary
      // sign-in boundary, never back on the wizard: the instance has its
      // administrator now.
      await signOutFromUserMenu(firstDevice.page)
      await expect(
        firstDevice.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expect(
        firstDevice.page.getByRole('heading', { name: 'Initialize Nevix AI' })
      ).toHaveCount(0)
    } finally {
      await firstDevice.electronApp.close()
    }
  } finally {
    await rm(firstDeviceDir, { recursive: true, force: true })
  }

  // A second device on the now-initialized instance: the wizard is gone, the
  // ordinary sign-in boundary is all it sees, and the credentials the wizard
  // chose sign the administrator in.
  const secondDeviceDir = await mkdtemp(join(tmpdir(), 'nevix-auth-setup-wizard-second-'))
  try {
    const secondDevice = await launchTestApp({
      userDataDir: secondDeviceDir,
      systemLanguages: ['en-US'],
      serverUrl: setupServer!.serverUrl
    })

    try {
      await expect(
        secondDevice.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expect(
        secondDevice.page.getByRole('heading', { name: 'Initialize Nevix AI' })
      ).toHaveCount(0)

      await secondDevice.page.getByLabel('Email').fill(FIRST_ADMIN_EMAIL)
      await secondDevice.page.getByLabel('Password').fill(FIRST_ADMIN_PASSWORD)
      await secondDevice.page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(
        secondDevice.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
    } finally {
      await secondDevice.electronApp.close()
    }
  } finally {
    await rm(secondDeviceDir, { recursive: true, force: true })
  }
})
