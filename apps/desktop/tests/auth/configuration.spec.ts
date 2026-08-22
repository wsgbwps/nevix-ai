import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'

async function expectAuthenticationUnavailable(expectedConnectSource: string): Promise<void> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-config-'))

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US']
    })

    try {
      await expect(
        launched.page.getByRole('heading', { name: 'Authentication is unavailable' })
      ).toBeVisible()
      await expect(
        launched.page.getByText('This build is missing a valid server address configuration.')
      ).toBeVisible()
      await expect(launched.page.getByRole('button', { name: 'Sign in' })).toHaveCount(0)
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toHaveCount(0)
      const policy = await launched.page
        .locator('meta[http-equiv="Content-Security-Policy"]')
        .getAttribute('content')
      expect(policy).toContain(`connect-src ${expectedConnectSource}`)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
}

test('missing or invalid VITE_SERVER_URL blocks the application at startup', async () => {
  test.skip(
    process.env.NEVIX_EXPECT_INVALID_SERVER_CONFIG !== '1',
    'requires the configuration-failure build produced by the E2E command'
  )

  await expectAuthenticationUnavailable("'none'")
})

test('production rejects a private HTTP server origin at the Authentication boundary', async () => {
  test.skip(
    process.env.NEVIX_EXPECT_PRODUCTION_PRIVATE_HTTP_BLOCK !== '1',
    'requires the production private-HTTP build produced by the E2E command'
  )

  await expectAuthenticationUnavailable("'none'")
})
