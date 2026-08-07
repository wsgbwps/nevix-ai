import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'
import {
  createAuthUser,
  readAuthHarnessConfig,
  uniqueAuthIdentity
} from '../auth/helpers/supabase-auth'
import {
  readMailpitHarnessConfig,
  readMailpitMessageIds,
  waitForRegistrationMessage
} from '../auth/helpers/mailpit'
import { endMembership, seedOrganizationWithMembership } from './helpers/organization-seed'

const authHarness = readAuthHarnessConfig()
const mailpitHarness = readMailpitHarnessConfig()
const serverUrl = process.env.NEVIX_TEST_SERVER_URL

const HOME_HEADING = 'Create with Nevix AI'
const PICKER_HEADING = 'Select an organization'
const ONBOARDING_HEADING = 'What should we call you?'

async function signIn(page: Page, identity: { email: string; password: string }): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible()
  await page.getByLabel('Email').fill(identity.email)
  await page.getByLabel('Password', { exact: true }).fill(identity.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

async function readRememberedOrganizationId(userDataDir: string): Promise<string> {
  const contents = await readFile(join(userDataDir, 'active-organization.json'), 'utf8')
  const value: unknown = JSON.parse(contents)
  const organizationId = (value as { organizationId?: unknown }).organizationId
  if (typeof organizationId !== 'string' || organizationId.length === 0) {
    throw new Error('The remembered Active Organization id was not persisted by the main process')
  }
  return organizationId
}

test(
  'restart restores the remembered Active Organization without localStorage',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(120_000)
    test.skip(
      !authHarness || !mailpitHarness || !serverUrl,
      'requires the Desktop onboarding integration harness'
    )
    if (!authHarness || !mailpitHarness || !serverUrl) return

    const identity = uniqueAuthIdentity('active-organization-restart')
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-active-organization-restart-'))
    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
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

      await expect(launched.page.getByRole('heading', { name: ONBOARDING_HEADING })).toBeVisible()
      await launched.page.getByLabel('Display name').fill('Avery')
      await launched.page.getByRole('button', { name: 'Continue' }).click()
      await launched.page.getByLabel('Organization name').fill('Nebula Design')
      await launched.page.getByRole('button', { name: 'Create organization and enter' }).click()
      await expect(launched.page.getByRole('heading', { name: HOME_HEADING })).toBeVisible()

      // Device memory lives in a main-process file, never in renderer localStorage.
      expect(await readRememberedOrganizationId(userDataDir)).toBeTruthy()
      expect(await launched.page.evaluate(() => localStorage.length)).toBe(0)
      await launched.electronApp.close()

      // Restart on the same device: the remembered Membership enters directly, no picker.
      const restarted = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await expect(restarted.page.getByRole('heading', { name: HOME_HEADING })).toBeVisible()
        await expect(restarted.page.getByRole('heading', { name: PICKER_HEADING })).toHaveCount(0)
        await expect(restarted.page.getByText('Nebula Design')).toBeVisible()
      } finally {
        await restarted.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)

test(
  'startup verification branches: zero Organizations onboard, one auto-selects, many show the picker',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(180_000)
    test.skip(!authHarness, 'requires the Desktop onboarding integration harness')
    if (!authHarness) return

    // Zero Organizations: startup lands on the onboarding view.
    const zeroIdentity = uniqueAuthIdentity('active-organization-zero')
    await createAuthUser(authHarness, zeroIdentity, true)
    const zeroUserDataDir = await mkdtemp(join(tmpdir(), 'nevix-active-organization-zero-'))
    try {
      const launched = await launchTestApp({
        userDataDir: zeroUserDataDir,
        systemLanguages: ['en-US']
      })
      try {
        await signIn(launched.page, zeroIdentity)
        await expect(launched.page.getByRole('heading', { name: ONBOARDING_HEADING })).toBeVisible()
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(zeroUserDataDir, { recursive: true, force: true })
    }

    // One Organization without device memory: startup auto-selects it.
    const singleIdentity = uniqueAuthIdentity('active-organization-single')
    const singleUserId = await createAuthUser(authHarness, singleIdentity, true)
    await seedOrganizationWithMembership(singleUserId, {
      name: 'Aurora Labs'
    })
    const singleUserDataDir = await mkdtemp(join(tmpdir(), 'nevix-active-organization-single-'))
    try {
      const launched = await launchTestApp({
        userDataDir: singleUserDataDir,
        systemLanguages: ['en-US']
      })
      try {
        await signIn(launched.page, singleIdentity)
        await expect(launched.page.getByRole('heading', { name: HOME_HEADING })).toBeVisible()
        await expect(launched.page.getByRole('heading', { name: PICKER_HEADING })).toHaveCount(0)
        await expect(launched.page.getByText('Aurora Labs')).toBeVisible()
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(singleUserDataDir, { recursive: true, force: true })
    }

    // Multiple Organizations without device memory: startup shows the picker, and the choice is
    // remembered through the main-process store.
    const manyIdentity = uniqueAuthIdentity('active-organization-many')
    const manyUserId = await createAuthUser(authHarness, manyIdentity, true)
    await seedOrganizationWithMembership(manyUserId, { name: 'Aurora Labs' })
    const chosenOrganization = await seedOrganizationWithMembership(manyUserId, {
      name: 'Beta Studio'
    })
    const manyUserDataDir = await mkdtemp(join(tmpdir(), 'nevix-active-organization-many-'))
    try {
      const launched = await launchTestApp({
        userDataDir: manyUserDataDir,
        systemLanguages: ['en-US']
      })
      try {
        await signIn(launched.page, manyIdentity)
        await expect(launched.page.getByRole('heading', { name: PICKER_HEADING })).toBeVisible()
        await expect(launched.page.getByText('Aurora Labs')).toBeVisible()
        await expect(launched.page.getByText('Beta Studio')).toBeVisible()
        await expect(launched.page.getByText('Last used')).toHaveCount(0)
        await expect(launched.page.getByRole('heading', { name: HOME_HEADING })).toHaveCount(0)

        await launched.page.getByRole('button', { name: 'Beta Studio' }).click()
        await expect(launched.page.getByRole('heading', { name: HOME_HEADING })).toBeVisible()
        expect(await readRememberedOrganizationId(manyUserDataDir)).toBe(chosenOrganization.id)
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(manyUserDataDir, { recursive: true, force: true })
    }
  }
)

test('an ended remembered Membership returns to the picker without entitled data', async () => {
  test.setTimeout(90_000)
  test.skip(!authHarness, 'requires the Desktop onboarding integration harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('active-organization-ended')
  const userId = await createAuthUser(authHarness, identity, true)
  const endedOrganization = await seedOrganizationWithMembership(userId, {
    name: 'Aurora Labs'
  })
  await seedOrganizationWithMembership(userId, { name: 'Beta Studio' })
  await endMembership(userId, endedOrganization.id)

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-active-organization-ended-'))
  try {
    // Device memory points at the ended Membership before the app launches.
    await writeFile(
      join(userDataDir, 'active-organization.json'),
      JSON.stringify({ organizationId: endedOrganization.id }),
      'utf8'
    )

    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await signIn(launched.page, identity)
      // The stale memory never auto-enters: the picker renders, and the ended Organization is
      // invisible because the RLS direct read is the single source of truth.
      await expect(launched.page.getByRole('heading', { name: PICKER_HEADING })).toBeVisible()
      await expect(launched.page.getByText('Beta Studio')).toBeVisible()
      await expect(launched.page.getByText('Aurora Labs')).toHaveCount(0)
      await expect(launched.page.getByRole('heading', { name: HOME_HEADING })).toHaveCount(0)

      await launched.page.getByRole('button', { name: 'Beta Studio' }).click()
      await expect(launched.page.getByRole('heading', { name: HOME_HEADING })).toBeVisible()
      await expect(launched.page.getByText('Aurora Labs')).toHaveCount(0)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})
