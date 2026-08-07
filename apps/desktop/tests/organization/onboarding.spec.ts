import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp, openSettingsFromUserMenu } from '../helpers/electron-app'
import { readAuthHarnessConfig, uniqueAuthIdentity } from '../auth/helpers/supabase-auth'
import {
  readMailpitHarnessConfig,
  readMailpitMessageIds,
  waitForRegistrationMessage
} from '../auth/helpers/mailpit'

const authHarness = readAuthHarnessConfig()
const mailpitHarness = readMailpitHarnessConfig()
const serverUrl = process.env.NEVIX_TEST_SERVER_URL

test(
  'a newly verified User completes the two-step onboarding flow and edits their Profile',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(90_000)
    test.skip(
      !authHarness || !mailpitHarness || !serverUrl,
      'requires the Desktop onboarding integration harness'
    )
    if (!authHarness || !mailpitHarness || !serverUrl) return

    const identity = uniqueAuthIdentity('organization-onboarding')
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-organization-onboarding-'))
    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await expect(
          launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
        ).toBeVisible()
        await launched.page.getByRole('button', { name: 'Create account' }).click()
        await launched.page.getByLabel('Email').fill(identity.email)
        await launched.page.getByLabel('Password', { exact: true }).fill(identity.password)
        await launched.page.getByLabel('Confirm password').fill(identity.password)

        const messagesBeforeSignup = await readMailpitMessageIds(mailpitHarness)
        await launched.page.getByRole('button', { name: 'Create account' }).click()
        const registration = await waitForRegistrationMessage(
          mailpitHarness,
          messagesBeforeSignup,
          identity.email
        )

        await launched.page.getByLabel('Verification code').fill(registration.code)
        await launched.page.getByRole('button', { name: 'Verify email' }).click()

        await expect(
          launched.page.getByRole('heading', { name: 'What should we call you?' })
        ).toBeVisible()
        await expect(launched.page.getByText('Step 1 of 2')).toBeVisible()

        const displayName = launched.page.getByLabel('Display name')
        await displayName.fill('   ')
        await launched.page.getByRole('button', { name: 'Continue' }).click()
        await expect(
          launched.page.getByRole('alert').filter({
            hasText: 'Enter a display name (not whitespace only)'
          })
        ).toBeVisible()

        await displayName.fill('x'.repeat(51))
        await launched.page.getByRole('button', { name: 'Continue' }).click()
        await expect(
          launched.page.getByRole('alert').filter({
            hasText: 'Display name is 50 characters at most'
          })
        ).toBeVisible()

        await displayName.fill('  Avery  ')
        const profileResponse = launched.page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' && response.url().includes('/rest/v1/profiles')
        )
        await launched.page.getByRole('button', { name: 'Continue' }).click()
        expect((await profileResponse).status()).toBe(201)

        await expect(
          launched.page.getByRole('heading', { name: 'Create your first organization' })
        ).toBeVisible()
        await expect(launched.page.getByText('Step 2 of 2')).toBeVisible()
        await launched.page.getByRole('button', { name: 'Back' }).click()
        await expect(displayName).toHaveValue('  Avery  ')
        await launched.page.getByRole('button', { name: 'Continue' }).click()

        const organizationName = launched.page.getByLabel('Organization name')
        await organizationName.fill('   ')
        await launched.page.getByRole('button', { name: 'Create organization and enter' }).click()
        await expect(
          launched.page.getByRole('alert').filter({ hasText: 'Enter an organization name' })
        ).toBeVisible()

        await organizationName.fill('Nebula Design')
        const submittedOrganizationIds: string[] = []
        let failFirstOrganizationRequest = true
        await launched.page.route('**/identity/organizations', async (route) => {
          const body = route.request().postData()
          if (!body) throw new Error('CreateOrganization request body is missing')
          const payload: unknown = JSON.parse(body)
          if (
            typeof payload !== 'object' ||
            payload === null ||
            typeof (payload as { id?: unknown }).id !== 'string'
          ) {
            throw new Error('CreateOrganization request id is missing')
          }
          submittedOrganizationIds.push((payload as { id: string }).id)

          if (failFirstOrganizationRequest) {
            failFirstOrganizationRequest = false
            await route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'internal_error', message: 'retry' })
            })
            return
          }

          await route.continue()
        })

        const createOrganizationButton = launched.page.getByRole('button', {
          name: 'Create organization and enter'
        })
        await createOrganizationButton.click()
        await expect.poll(() => submittedOrganizationIds.length).toBe(1)
        await expect(createOrganizationButton).toBeEnabled()

        const organizationResponse = launched.page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            response.url() === `${serverUrl}/identity/organizations`
        )
        await createOrganizationButton.click()
        expect((await organizationResponse).status()).toBe(200)
        expect(submittedOrganizationIds).toHaveLength(2)
        expect(submittedOrganizationIds[1]).toBe(submittedOrganizationIds[0])
        await launched.page.unroute('**/identity/organizations')

        await expect(
          launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
        ).toBeVisible()

        await openSettingsFromUserMenu(launched.page)
        await expect(launched.page.getByRole('heading', { name: 'Profile' })).toBeVisible()
        const profileDisplayName = launched.page.getByLabel('Display name')
        await expect(profileDisplayName).toHaveValue('Avery')
        await expect(launched.page.getByRole('button', { name: 'Save' })).toBeDisabled()
        await expect(launched.page.getByRole('button', { name: 'Cancel' })).toBeDisabled()

        await profileDisplayName.fill('   ')
        await launched.page.getByRole('button', { name: 'Save' }).click()
        await expect(
          launched.page.getByRole('alert').filter({
            hasText: 'Enter a display name (not whitespace only)'
          })
        ).toBeVisible()
        await profileDisplayName.fill('x'.repeat(51))
        await launched.page.getByRole('button', { name: 'Save' }).click()
        await expect(
          launched.page.getByRole('alert').filter({
            hasText: 'Display name is 50 characters at most'
          })
        ).toBeVisible()

        await profileDisplayName.fill('Avery Updated')
        await expect(launched.page.getByRole('button', { name: 'Save' })).toBeEnabled()
        await expect(launched.page.getByRole('button', { name: 'Cancel' })).toBeEnabled()
        await launched.page.getByRole('button', { name: 'Cancel' }).click()
        await expect(profileDisplayName).toHaveValue('Avery')
        await expect(launched.page.getByRole('button', { name: 'Save' })).toBeDisabled()

        await profileDisplayName.fill('Avery Updated')
        await launched.page.getByRole('button', { name: 'Save' }).click()
        await expect(launched.page.getByRole('status')).toHaveText('Display name updated.')
        await expect(launched.page.getByRole('button', { name: 'Save' })).toBeDisabled()
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)
