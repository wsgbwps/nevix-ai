import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp, openSettingsFromUserMenu } from '../helpers/electron-app'
import {
  createAuthUser,
  deleteAuthUser,
  readAuthHarnessConfig,
  signInOutsideDesktop,
  uniqueAuthIdentity
} from '../auth/helpers/supabase-auth'
import {
  readMailpitHarnessConfig,
  readMailpitMessageIds,
  waitForRegistrationMessage
} from '../auth/helpers/mailpit'
import {
  endMembership,
  seedOrganizationWithMembership
} from '../organization/helpers/organization-seed'

const authHarness = readAuthHarnessConfig()
const mailpitHarness = readMailpitHarnessConfig()
const serverUrl = process.env.NEVIX_TEST_SERVER_URL

async function signIn(page: Page, identity: { email: string; password: string }): Promise<void> {
  await page.getByLabel('Email').fill(identity.email)
  await page.getByLabel('Password', { exact: true }).fill(identity.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

async function createInvitation(
  organizationId: string,
  accessToken: string,
  email: string
): Promise<void> {
  if (!serverUrl) throw new Error('Identity server URL is unavailable')
  const response = await fetch(
    new URL(`/identity/organizations/${organizationId}/invitations`, serverUrl),
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email })
    }
  )
  if (!response.ok) throw new Error(`Unable to create test invitation: ${response.status}`)
}

test('Settings picker cancellation retains context and selection returns with permission fallback @smoke', async () => {
  test.setTimeout(120_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('settings-organization-picker')
  const userId = await createAuthUser(authHarness, identity, true)
  const originalOrganization = await seedOrganizationWithMembership(userId, {
    name: 'Original Settings Studio'
  })
  const memberOrganization = await seedOrganizationWithMembership(userId, {
    name: 'Member Destination Studio',
    role: 'member'
  })
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-settings-organization-picker-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await signIn(launched.page, identity)
      await expect(
        launched.page.getByRole('heading', { name: 'Select an organization' })
      ).toBeVisible()
      await launched.page.getByRole('button', { name: originalOrganization.name }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()

      await openSettingsFromUserMenu(launched.page)
      const settingsNavigation = launched.page.getByRole('navigation', { name: 'Settings' })
      const displayName = launched.page.getByLabel('Display name')
      await expect(displayName).toHaveValue('E2E User')
      await displayName.fill('Discarded picker draft')
      await launched.page.getByRole('button', { name: 'All organizations' }).click()
      const discardDialog = launched.page.getByRole('dialog', {
        name: 'Discard unsaved changes?'
      })
      await expect(discardDialog).toBeVisible()
      await discardDialog.getByRole('button', { name: 'Discard changes' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Select an organization' })
      ).toBeVisible()
      await launched.page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(launched.page.getByRole('heading', { name: 'Profile' })).toBeVisible()
      await expect(displayName).toHaveValue('E2E User')
      await settingsNavigation.getByRole('button', { name: 'Audit log' }).click()
      await expect(launched.page.getByRole('heading', { name: 'Audit log' })).toBeVisible()

      await launched.page.getByRole('button', { name: 'All organizations' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Select an organization' })
      ).toBeVisible()
      await launched.page.getByRole('button', { name: 'Cancel', exact: true }).click()

      await expect(launched.page.getByRole('heading', { name: 'Audit log' })).toBeVisible()
      await expect(
        launched.page.getByText(originalOrganization.name, { exact: true })
      ).toBeVisible()

      await launched.page.getByRole('button', { name: 'All organizations' }).click()
      await launched.page.route(
        '**/rest/v1/memberships*',
        async (route) => {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'temporary selection failure' })
          })
        },
        { times: 1 }
      )
      await launched.page.getByRole('button', { name: memberOrganization.name }).click()
      await expect(launched.page.getByRole('alert')).toHaveText(
        'Unable to switch organizations right now. Try again.'
      )
      await expect(
        launched.page.getByRole('heading', { name: 'Select an organization' })
      ).toBeVisible()
      await launched.page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(launched.page.getByRole('heading', { name: 'Audit log' })).toBeVisible()
      await expect(
        launched.page.getByText(originalOrganization.name, { exact: true })
      ).toBeVisible()

      await launched.page.getByRole('button', { name: 'All organizations' }).click()
      await launched.page.getByRole('button', { name: memberOrganization.name }).click()

      await expect(
        launched.page.getByRole('heading', { name: 'Members', exact: true })
      ).toBeVisible()
      await expect(settingsNavigation.getByRole('button', { name: 'Audit log' })).toHaveCount(0)
      await expect(launched.page.getByText(memberOrganization.name, { exact: true })).toBeVisible()
      await expect(
        launched.page.getByRole('complementary').getByText('Member', { exact: true })
      ).toBeVisible()
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, userId)
  }
})

test('Settings-origin Organization creation returns to the original account Section', async () => {
  test.setTimeout(90_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('settings-organization-picker-create')
  const userId = await createAuthUser(authHarness, identity, true)
  await seedOrganizationWithMembership(userId, { name: 'Creation Source Studio' })
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-settings-picker-create-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await signIn(launched.page, identity)
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      await openSettingsFromUserMenu(launched.page)
      await expect(launched.page.getByRole('heading', { name: 'Profile' })).toBeVisible()

      await launched.page.getByRole('button', { name: 'All organizations' }).click()
      await launched.page.getByRole('button', { name: 'Create new organization' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create your first organization' })
      ).toBeVisible()
      await launched.page.getByLabel('Organization name').fill('Created From Settings Studio')
      let createRequestCount = 0
      await launched.page.route('**/identity/organizations', async (route) => {
        createRequestCount += 1
        await route.continue()
      })
      await launched.page.route(
        '**/rest/v1/memberships*',
        async (route) => {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'temporary created Membership failure' })
          })
        },
        { times: 1 }
      )
      await launched.page.getByRole('button', { name: 'Create organization and enter' }).click()
      await expect(launched.page.getByRole('alert')).toHaveText(
        'The Organization was created, but its Membership is not confirmed yet.'
      )
      expect(createRequestCount).toBe(1)
      await launched.page.getByRole('button', { name: 'Check again' }).click()
      expect(createRequestCount).toBe(1)

      await expect(launched.page.getByRole('heading', { name: 'Profile' })).toBeVisible()
      const settingsSidebar = launched.page.getByRole('complementary')
      await expect(settingsSidebar.getByText('Created From Settings Studio')).toBeVisible()
      await expect(settingsSidebar.getByText('Owner', { exact: true })).toBeVisible()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toHaveCount(0)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, userId)
  }
})

test('cancel after the original Membership ends falls back to the startup picker path', async () => {
  test.setTimeout(90_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('settings-organization-picker-ended')
  const userId = await createAuthUser(authHarness, identity, true)
  const endedOrganization = await seedOrganizationWithMembership(userId, {
    name: 'Ended Settings Studio'
  })
  const remainingOrganization = await seedOrganizationWithMembership(userId, {
    name: 'Remaining Startup Studio'
  })
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-settings-picker-ended-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await signIn(launched.page, identity)
      await launched.page.getByRole('button', { name: endedOrganization.name }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      await openSettingsFromUserMenu(launched.page)
      await launched.page
        .getByRole('navigation', { name: 'Settings' })
        .getByRole('button', { name: 'Members', exact: true })
        .click()
      await expect(
        launched.page.getByRole('heading', { name: 'Members', exact: true })
      ).toBeVisible()

      await launched.page.getByRole('button', { name: 'All organizations' }).click()
      await endMembership(userId, endedOrganization.id)
      await launched.page.getByRole('button', { name: 'Cancel', exact: true }).click()

      const accessLost = launched.page.getByRole('dialog', {
        name: `You lost access to "${endedOrganization.name}"`
      })
      await expect(accessLost).toBeVisible()
      await accessLost.getByRole('button', { name: 'Got it' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Select an organization' })
      ).toBeVisible()
      await expect(launched.page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(
        0
      )
      await expect(launched.page.getByText(endedOrganization.name, { exact: true })).toHaveCount(0)

      await launched.page.getByRole('button', { name: remainingOrganization.name }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, userId)
  }
})

test('Settings-origin Invitation acceptance returns to the original account Section', async () => {
  test.setTimeout(120_000)
  test.skip(
    !authHarness || !mailpitHarness || !serverUrl,
    'requires the disposable Invitation acceptance harness'
  )
  if (!authHarness || !mailpitHarness || !serverUrl) return

  const ownerIdentity = uniqueAuthIdentity('settings-picker-invitation-owner')
  const inviteeIdentity = uniqueAuthIdentity('settings-picker-invitation-invitee')
  const ownerId = await createAuthUser(authHarness, ownerIdentity, true)
  const inviteeId = await createAuthUser(authHarness, inviteeIdentity, true)
  const invitedOrganization = await seedOrganizationWithMembership(ownerId, {
    name: 'Invited Settings Studio'
  })
  const originalOrganization = await seedOrganizationWithMembership(inviteeId, {
    name: 'Invitation Source Studio'
  })
  const ownerSession = await signInOutsideDesktop(authHarness, ownerIdentity)
  const messagesBeforeInvitation = await readMailpitMessageIds(mailpitHarness)
  await createInvitation(invitedOrganization.id, ownerSession.access_token, inviteeIdentity.email)
  const invitationMessage = await waitForRegistrationMessage(
    mailpitHarness,
    messagesBeforeInvitation,
    inviteeIdentity.email
  )
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-settings-picker-invitation-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await signIn(launched.page, inviteeIdentity)
      await expect(
        launched.page.getByRole('heading', { name: 'Select an organization' })
      ).toBeVisible()
      await launched.page.getByRole('button', { name: originalOrganization.name }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      await openSettingsFromUserMenu(launched.page)
      await launched.page
        .getByRole('navigation', { name: 'Settings' })
        .getByRole('button', { name: 'Language' })
        .click()
      await expect(
        launched.page.getByRole('combobox', { name: 'Interface language' })
      ).toBeVisible()

      await launched.page.getByRole('button', { name: 'All organizations' }).click()
      await launched.page.getByRole('button', { name: 'Accept' }).click()
      await launched.page
        .getByRole('textbox', { name: 'Invitation code' })
        .fill(invitationMessage.code)
      let acceptanceRequestCount = 0
      await launched.page.route('**/identity/invitations/*/accept', async (route) => {
        acceptanceRequestCount += 1
        await route.continue()
      })
      await launched.page.route(
        '**/rest/v1/memberships*',
        async (route) => {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'temporary accepted Membership failure' })
          })
        },
        { times: 1 }
      )
      await launched.page.getByRole('button', { name: 'Verify and join' }).click()
      await expect(launched.page.getByRole('alert')).toHaveText(
        'The Invitation was accepted, but its Membership is not confirmed yet.'
      )
      expect(acceptanceRequestCount).toBe(1)
      await launched.page.getByRole('button', { name: 'Check again' }).click()
      expect(acceptanceRequestCount).toBe(1)

      await expect(
        launched.page.getByRole('combobox', { name: 'Interface language' })
      ).toBeVisible()
      const settingsSidebar = launched.page.getByRole('complementary')
      await expect(
        settingsSidebar.getByText(invitedOrganization.name, { exact: true })
      ).toBeVisible()
      await expect(settingsSidebar.getByText('Member', { exact: true })).toBeVisible()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toHaveCount(0)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, inviteeId)
    await deleteAuthUser(authHarness, ownerId)
  }
})
