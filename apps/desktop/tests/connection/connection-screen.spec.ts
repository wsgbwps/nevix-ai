import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'

const serverUrl = process.env.NEVIX_TEST_SERVER_URL

test(
  'an unconfigured device first launches onto the Connection Screen',
  { tag: '@smoke' },
  async () => {
    test.skip(!serverUrl, 'requires the identity server stack produced by the E2E command')

    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-connection-first-'))

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

      try {
        await expect(
          launched.page.getByRole('heading', { name: 'Connect to your Nevix server' })
        ).toBeVisible()
        await expect(launched.page.getByLabel('Server address')).toBeVisible()
        // Testing stays gated until a URL is entered; save stays gated until a
        // probe of the exact draft has passed.
        await expect(launched.page.getByRole('button', { name: 'Test connection' })).toBeDisabled()
        await launched.page.getByLabel('Server address').fill(serverUrl!)
        await expect(launched.page.getByRole('button', { name: 'Test connection' })).toBeEnabled()
        await expect(
          launched.page.getByRole('button', { name: 'Save and continue' })
        ).toBeDisabled()
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)

test('the Connection Screen rejects malformed and public plain-http addresses', async () => {
  test.skip(!serverUrl, 'requires the identity server stack produced by the E2E command')

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-connection-policy-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

    try {
      for (const url of ['http://8.8.8.8:8080', 'http://nevix.example', 'not a url']) {
        await launched.page.getByLabel('Server address').fill(url)
        await launched.page.getByRole('button', { name: 'Test connection' }).click()
        await expect(
          launched.page.getByText('Invalid address: public addresses require https')
        ).toBeVisible()
        await expect(
          launched.page.getByRole('button', { name: 'Save and continue' })
        ).toBeDisabled()
      }
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('an unreachable address reports a retryable connection failure', async () => {
  test.skip(!serverUrl, 'requires the identity server stack produced by the E2E command')

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-connection-unreachable-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

    try {
      await launched.page.getByLabel('Server address').fill('http://127.0.0.1:9')
      await launched.page.getByRole('button', { name: 'Test connection' }).click()
      await expect(launched.page.getByText('Could not reach the server')).toBeVisible({
        timeout: 20_000
      })
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test(
  'an intranet http address is allowed, saved, and leads into the login boundary',
  { tag: '@smoke' },
  async () => {
    test.skip(!serverUrl, 'requires the identity server stack produced by the E2E command')

    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-connection-http-'))

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

      try {
        await launched.page.getByLabel('Server address').fill(serverUrl!)
        await launched.page.getByRole('button', { name: 'Test connection' }).click()
        await expect(launched.page.getByTestId('connection-probe-reachable')).toBeVisible()
        await launched.page
          .getByRole('button', { name: 'Save and continue' })
          .click({ noWaitAfter: true })

        await expect(
          launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
        ).toBeVisible({ timeout: 20_000 })
      } finally {
        await launched.electronApp.close()
      }

      // The saved connection persists: a relaunch goes straight to login.
      const relaunched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

      try {
        await expect(
          relaunched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
        ).toBeVisible({ timeout: 20_000 })
        await expect(
          relaunched.page.getByRole('heading', { name: 'Connect to your Nevix server' })
        ).toHaveCount(0)
      } finally {
        await relaunched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)
