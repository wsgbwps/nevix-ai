import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'

// The setup-status probe decides whether the boundary is the first-admin
// wizard or ordinary sign-in. When the server cannot be asked (issue #128,
// ADR-0015 2026-08-24 revision), the boundary shows a retryable error — never
// a fallback to a sign-in that cannot succeed on an empty instance, and never
// a wizard guess. The unreachable port needs no server infrastructure.
const UNREACHABLE_SERVER_URL = 'http://127.0.0.1:9'

test('a failed setup-status probe shows a retryable error instead of the login form', async () => {
  const deviceDir = await mkdtemp(join(tmpdir(), 'nevix-auth-setup-probe-failure-'))
  try {
    const device = await launchTestApp({
      userDataDir: deviceDir,
      systemLanguages: ['en-US'],
      serverUrl: UNREACHABLE_SERVER_URL
    })

    try {
      await expect(
        device.page.getByRole('heading', { name: 'Server status unavailable' })
      ).toBeVisible()
      await expect(device.page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toHaveCount(0)
      await expect(device.page.getByRole('heading', { name: 'Initialize Nevix AI' })).toHaveCount(0)

      // Retrying while the server stays unreachable keeps the honest error —
      // the boundary never falls back to the login form.
      await device.page.getByRole('button', { name: 'Try again' }).click()
      await expect(
        device.page.getByRole('heading', { name: 'Server status unavailable' })
      ).toBeVisible()
      await expect(device.page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toHaveCount(0)
    } finally {
      await device.electronApp.close()
    }
  } finally {
    await rm(deviceDir, { recursive: true, force: true })
  }
})
