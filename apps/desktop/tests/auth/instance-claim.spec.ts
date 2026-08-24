import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'
import { claimInstance, readOpenServerConfig } from './helpers/identity-server'

const openServer = readOpenServerConfig()

// The default Instance Claim is open (issue #128): no credential, no setup-code
// field. The raw-HTTP claim below wins the first-wins race while the wizard is
// open, so this spec also drives the losing device's path: 409 lands it on the
// ordinary sign-in boundary, where the winner's credentials sign straight in.
const WINNER_EMAIL = 'race-winner@nevix-e2e.test'
const WINNER_PASSWORD = 'correct horse battery staple'
const LOSER_EMAIL = 'race-loser@nevix-e2e.test'
const LOSER_PASSWORD = 'another horse battery staple'

test('the open claim wizard needs no setup code; the first claim wins and losers land on sign-in', async () => {
  test.skip(
    !openServer,
    'requires the disposable open empty-instance server built by the E2E command'
  )
  if (!openServer) return

  const deviceDir = await mkdtemp(join(tmpdir(), 'nevix-auth-instance-claim-'))
  try {
    const device = await launchTestApp({
      userDataDir: deviceDir,
      systemLanguages: ['en-US'],
      serverUrl: openServer!.serverUrl
    })

    try {
      // The empty instance swaps the login boundary for the first-admin
      // wizard — and the open claim has no setup-code field at all.
      await expect(device.page.getByRole('heading', { name: 'Initialize Nevix AI' })).toBeVisible()
      await expect(device.page.getByLabel('Setup code')).toHaveCount(0)

      await device.page.getByLabel('Email').fill(LOSER_EMAIL)
      await device.page.getByLabel('Password', { exact: true }).fill(LOSER_PASSWORD)
      await device.page.getByLabel('Confirm password').fill(LOSER_PASSWORD)
      await device.page.getByLabel('Display name (optional)').fill('Race Loser')

      // While the wizard is open, the instance is claimed over raw HTTP —
      // the same public claim command — so this device's submit becomes the
      // concurrent loser.
      await claimInstance(
        openServer!.serverUrl,
        WINNER_EMAIL,
        WINNER_PASSWORD,
        undefined,
        'Race Winner'
      )

      await device.page.getByRole('button', { name: 'Create administrator and continue' }).click()

      // The losing submit answers 409: the boundary returns to ordinary
      // sign-in with the explanation, never back to the wizard.
      await expect(device.page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible()
      await expect(
        device.page.getByText('This instance was already initialized. Sign in below.')
      ).toBeVisible()
      await expect(device.page.getByRole('heading', { name: 'Initialize Nevix AI' })).toHaveCount(0)

      // The winner's credentials sign the losing device straight into the
      // shell — the instance is initialized, ordinary login is the way in.
      await device.page.getByLabel('Email').fill(WINNER_EMAIL)
      await device.page.getByLabel('Password').fill(WINNER_PASSWORD)
      await device.page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(device.page.getByRole('heading', { name: 'Create with Nevix AI' })).toBeVisible()
    } finally {
      await device.electronApp.close()
    }
  } finally {
    await rm(deviceDir, { recursive: true, force: true })
  }
})
