import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAuthUser,
  deleteAuthUser,
  readAuthHarnessConfig,
  uniqueAuthIdentity
} from '../auth/helpers/supabase-auth'
import {
  readMailpitHarnessConfig,
  readMailpitMessageIds,
  waitForRegistrationMessage
} from '../auth/helpers/mailpit'
import {
  expectMainWindowCount,
  launchTestApp,
  openSettingsSectionFromUserMenu,
  requestOrdinaryWindowClose
} from '../helpers/electron-app'
import {
  ageInvitationCodeBeyondCooldown,
  readPendingInvitationId,
  seedActiveMembership,
  seedOrganizationWithMembership,
  seedProfile
} from './helpers/organization-seed'

const authHarness = readAuthHarnessConfig()
const mailpitHarness = readMailpitHarnessConfig()

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function forceCloseTestApp(electronApp: ElectronApplication): Promise<void> {
  const process = electronApp.process()
  if (process.exitCode !== null) return

  const exited = new Promise<void>((resolve) => {
    process.once('exit', () => resolve())
  })
  process.kill('SIGKILL')
  await exited
}
async function signIn(
  page: Page,
  identity: { readonly email: string; readonly password: string }
): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible()
  await page.getByLabel('Email').fill(identity.email)
  await page.getByLabel('Password', { exact: true }).fill(identity.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  const homeHeading = page.getByRole('heading', { name: 'Create with Nevix AI' })
  const retryButton = page.getByRole('button', { name: 'Try again', exact: true })
  await expect(homeHeading.or(retryButton)).toBeVisible()
  if (await retryButton.isVisible()) await retryButton.click()
  await expect(homeHeading).toBeVisible()
}

function memberRow(page: Page, displayName: string): Locator {
  return page.getByText(displayName, { exact: true }).locator('..').locator('..')
}

test(
  'a Member sees a read-only display-name roster and no management surfaces',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(90_000)
    test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
    if (!authHarness) return

    const ownerIdentity = uniqueAuthIdentity('members-read-only-owner')
    const ownerId = await createAuthUser(authHarness, ownerIdentity, true)
    const organization = await seedOrganizationWithMembership(ownerId, {
      name: 'Read-only Studio',
      profileDisplayName: 'Olivia Owner'
    })
    const memberIdentity = uniqueAuthIdentity('members-read-only-member')
    const memberId = await createAuthUser(authHarness, memberIdentity, true)
    await seedProfile(memberId, 'Mina Member')
    await seedActiveMembership(organization.id, memberId, 'member')
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-members-read-only-'))

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await signIn(launched.page, memberIdentity)
        await openSettingsSectionFromUserMenu(launched.page, 'Members')

        const settingsNavigation = launched.page.getByRole('navigation', { name: 'Settings' })
        const settingsSidebar = launched.page.getByRole('complementary')
        await expect(settingsNavigation.getByText('Organization', { exact: true })).toBeVisible()
        await expect(settingsSidebar.getByText('Read-only Studio', { exact: true })).toBeVisible()
        await expect(settingsSidebar.getByText('Member', { exact: true })).toBeVisible()
        await expect(
          settingsSidebar.getByRole('button', { name: 'All organizations' })
        ).toBeVisible()

        await expect(
          launched.page.getByRole('heading', { name: 'Members', exact: true })
        ).toBeVisible()
        await expect(launched.page.getByText('Olivia Owner', { exact: true })).toBeVisible()
        await expect(launched.page.getByText('Mina Member', { exact: true })).toBeVisible()
        await expect(
          launched.page.getByText('The Member role can only view the roster.')
        ).toBeVisible()
        await expect(launched.page.getByText(ownerIdentity.email, { exact: true })).toHaveCount(0)
        await expect(launched.page.getByText(memberIdentity.email, { exact: true })).toHaveCount(0)
        await expect(launched.page.getByRole('button', { name: 'Invite member' })).toHaveCount(0)
        await expect(launched.page.getByRole('tab', { name: /Pending invitations/ })).toHaveCount(0)
        await expect(launched.page.getByRole('combobox', { name: /Change role/ })).toHaveCount(0)
        await expect(launched.page.getByRole('button', { name: /Remove member/ })).toHaveCount(0)
        const settingsMain = launched.page.getByRole('main')
        await expect(settingsMain.getByText('Organization name', { exact: true })).toHaveCount(0)
        await settingsNavigation
          .getByRole('button', { name: 'Organization details', exact: true })
          .click()
        await expect(
          settingsMain.getByRole('heading', { name: 'Organization details', exact: true })
        ).toBeVisible()
        await expect(settingsMain.getByText('Organization name', { exact: true })).toBeVisible()
        await expect(settingsMain.getByText('Read-only Studio', { exact: true })).toBeVisible()
        await expect(
          settingsMain.getByRole('textbox', { name: 'Organization name', exact: true })
        ).toHaveCount(0)
        await expect(
          settingsMain.getByRole('button', { name: 'Apply organization rename' })
        ).toHaveCount(0)
        await expect(
          settingsMain.getByRole('button', { name: 'Discard organization rename' })
        ).toHaveCount(0)
        await expect(settingsNavigation.getByRole('button', { name: 'Audit log' })).toHaveCount(0)
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
      await deleteAuthUser(authHarness, memberId)
      await deleteAuthUser(authHarness, ownerId)
    }
  }
)

test(
  'an Owner creates, resends, and revokes Invitations with an exact pending badge',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(90_000)
    test.skip(!authHarness || !mailpitHarness, 'requires disposable Supabase Auth and Mailpit')
    if (!authHarness || !mailpitHarness) return

    const ownerIdentity = uniqueAuthIdentity('members-invitation-owner')
    const ownerId = await createAuthUser(authHarness, ownerIdentity, true)
    const organization = await seedOrganizationWithMembership(ownerId, {
      name: 'Invitation Studio',
      profileDisplayName: 'Iris Owner'
    })
    const firstInvitee = uniqueAuthIdentity('members-invitation-first')
    const mixedCaseFirstInviteeEmail = firstInvitee.email.toUpperCase()
    const secondInvitee = uniqueAuthIdentity('members-invitation-second')
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-members-invitations-'))

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await signIn(launched.page, ownerIdentity)
        await openSettingsSectionFromUserMenu(launched.page, 'Members')

        const pendingTab = launched.page.getByRole('tab', { name: /Pending invitations/ })
        await pendingTab.click()
        await expect(pendingTab).toContainText('0')

        let membershipReadCount = 0
        let membersReadCount = 0
        let invitationsReadCount = 0
        await launched.page.route('**/rest/v1/memberships*', async (route) => {
          const select = new URL(route.request().url()).searchParams.get('select')
          if (select?.includes('organizations')) membershipReadCount += 1
          else membersReadCount += 1
          await route.continue()
        })
        await launched.page.route('**/rest/v1/invitations*', async (route) => {
          invitationsReadCount += 1
          await route.continue()
        })

        const firstMessages = await readMailpitMessageIds(mailpitHarness)
        await launched.page.getByRole('button', { name: 'Invite member' }).click()
        const firstDialog = launched.page.getByRole('dialog', { name: 'Invite member' })
        await firstDialog.getByLabel('Email').fill(mixedCaseFirstInviteeEmail)
        await firstDialog.getByRole('button', { name: 'Send invitation' }).click()
        await expect(launched.page.getByRole('status')).toHaveText(
          `Invitation sent to ${mixedCaseFirstInviteeEmail}`
        )
        expect(membershipReadCount).toBeGreaterThanOrEqual(1)
        expect(membersReadCount).toBeGreaterThanOrEqual(1)
        expect(invitationsReadCount).toBeGreaterThanOrEqual(1)
        const firstMessage = await waitForRegistrationMessage(
          mailpitHarness,
          firstMessages,
          firstInvitee.email
        )

        const secondMessages = await readMailpitMessageIds(mailpitHarness)
        await launched.page.getByRole('button', { name: 'Invite member' }).click()
        const secondDialog = launched.page.getByRole('dialog', { name: 'Invite member' })
        await secondDialog.getByLabel('Email').fill(secondInvitee.email)
        await secondDialog.getByRole('button', { name: 'Send invitation' }).click()
        await waitForRegistrationMessage(mailpitHarness, secondMessages, secondInvitee.email)

        const pendingPanel = launched.page.getByRole('tabpanel', {
          name: 'Pending invitations'
        })
        await expect(pendingPanel.getByText(firstInvitee.email, { exact: true })).toBeVisible()
        await expect(pendingPanel.getByText(secondInvitee.email, { exact: true })).toBeVisible()
        await expect(pendingTab).toContainText('2')

        const firstInvitationId = await readPendingInvitationId(organization.id, firstInvitee.email)
        await ageInvitationCodeBeyondCooldown(firstInvitationId)
        const resendMessages = await readMailpitMessageIds(mailpitHarness)
        await pendingPanel
          .getByRole('button', { name: `Resend invitation to ${firstInvitee.email}` })
          .click()
        const resendDialog = launched.page.getByRole('dialog', { name: 'Resend' })
        await expect(resendDialog.getByText(firstInvitee.email, { exact: true })).toBeVisible()
        await resendDialog.getByRole('button', { name: 'Resend', exact: true }).click()
        const resentMessage = await waitForRegistrationMessage(
          mailpitHarness,
          resendMessages,
          firstInvitee.email
        )
        expect(resentMessage.id).not.toBe(firstMessage.id)
        await expect(launched.page.getByRole('status')).toHaveText(
          'Resent. The new code is valid for 7 days.'
        )

        await pendingPanel
          .getByRole('button', { name: `Revoke invitation to ${secondInvitee.email}` })
          .click()
        const revokeDialog = launched.page.getByRole('dialog', { name: 'Revoke' })
        await expect(revokeDialog.getByText(secondInvitee.email, { exact: true })).toBeVisible()
        await revokeDialog.getByRole('button', { name: 'Revoke', exact: true }).click()
        await expect(pendingPanel.getByText(secondInvitee.email, { exact: true })).toHaveCount(0)
        await expect(pendingPanel.getByText(firstInvitee.email, { exact: true })).toBeVisible()
        await expect(pendingTab).toContainText('1')
        await expect(launched.page.getByRole('status')).toHaveText('Invitation revoked.')

        const settingsNavigation = launched.page.getByRole('navigation', { name: 'Settings' })
        await settingsNavigation.getByRole('button', { name: 'Profile' }).click()
        await expect(launched.page.getByRole('heading', { name: 'Profile' })).toBeVisible()
        await settingsNavigation.getByRole('button', { name: 'Members', exact: true }).click()
        await expect(
          launched.page.getByRole('tab', { name: 'Members', exact: true })
        ).toHaveAttribute('aria-selected', 'true')
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
      await deleteAuthUser(authHarness, ownerId)
    }
  }
)

test(
  'a completed mutation exposes retry when its RLS projection refresh fails',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(90_000)
    test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
    if (!authHarness) return

    const ownerIdentity = uniqueAuthIdentity('members-projection-retry-owner')
    const ownerId = await createAuthUser(authHarness, ownerIdentity, true)
    await seedOrganizationWithMembership(ownerId, {
      name: 'Projection Retry Studio',
      profileDisplayName: 'Riley Owner'
    })
    const invitee = uniqueAuthIdentity('members-projection-retry-invitee')
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-members-projection-retry-'))

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await signIn(launched.page, ownerIdentity)
        await openSettingsSectionFromUserMenu(launched.page, 'Members')
        await launched.page.getByRole('tab', { name: /Pending invitations/ }).click()

        await launched.page.route(
          '**/rest/v1/invitations*',
          (route) =>
            route.fulfill({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({ message: 'temporary projection failure' })
            }),
          { times: 1 }
        )
        await launched.page.getByRole('button', { name: 'Invite member' }).click()
        const dialog = launched.page.getByRole('dialog', { name: 'Invite member' })
        await dialog.getByLabel('Email').fill(invitee.email)
        await dialog.getByRole('button', { name: 'Send invitation' }).click()

        await expect(dialog).toHaveCount(0)
        await expect(
          launched.page.getByText('Unable to load members right now. Try again.')
        ).toBeVisible()
        await launched.page.getByRole('button', { name: 'Retry loading members' }).click()
        const pendingTab = launched.page.getByRole('tab', { name: /Pending invitations/ })
        await expect(pendingTab).toContainText('1')
        await pendingTab.click()
        await expect(launched.page.getByText(invitee.email, { exact: true })).toBeVisible()
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
      await deleteAuthUser(authHarness, ownerId)
    }
  }
)
test(
  'an Owner renames everywhere despite a failed pre-write Organization projection',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(90_000)
    test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
    if (!authHarness) return

    const ownerIdentity = uniqueAuthIdentity('members-owner-management')
    const memberIdentity = uniqueAuthIdentity('members-owner-member')
    const adminIdentity = uniqueAuthIdentity('members-owner-admin')
    const ownerId = await createAuthUser(authHarness, ownerIdentity, true)
    const memberId = await createAuthUser(authHarness, memberIdentity, true)
    const adminId = await createAuthUser(authHarness, adminIdentity, true)
    const organization = await seedOrganizationWithMembership(ownerId, {
      name: 'Membership Studio',
      profileDisplayName: 'Opal Owner'
    })
    await seedProfile(memberId, 'Mason Member')
    await seedActiveMembership(organization.id, memberId, 'member')
    await seedProfile(adminId, 'Ada Admin')
    await seedActiveMembership(organization.id, adminId, 'admin')
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-members-owner-management-'))
    let activeProjectionRequestCount = 0
    let preWriteRefreshCompleted = false
    let releasePreWriteRefresh = (): void => undefined
    const preWriteRefreshGate = new Promise<void>((resolve) => {
      releasePreWriteRefresh = resolve
    })

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await signIn(launched.page, ownerIdentity)
        await expect(
          launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
        ).toBeVisible()
        await launched.page.route('**/rest/v1/memberships*', async (route) => {
          const select = new URL(route.request().url()).searchParams.get('select')
          if (!select?.includes('organizations')) {
            await route.continue()
            return
          }

          activeProjectionRequestCount += 1
          if (activeProjectionRequestCount === 1) {
            await preWriteRefreshGate
            await route.fulfill({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({ message: 'stale pre-write projection failed' })
            })
            preWriteRefreshCompleted = true
            return
          }
          await route.continue()
        })
        await openSettingsSectionFromUserMenu(launched.page, 'Members')
        await expect.poll(() => activeProjectionRequestCount).toBe(2)

        await expect(memberRow(launched.page, 'Mason Member')).toContainText('Member')
        await expect(memberRow(launched.page, 'Ada Admin')).toContainText('Admin')
        await expect(launched.page.getByText(memberIdentity.email, { exact: true })).toHaveCount(0)
        await expect(launched.page.getByText(adminIdentity.email, { exact: true })).toHaveCount(0)

        const roleSelect = launched.page.getByRole('combobox', {
          name: 'Change role for Mason Member'
        })
        await roleSelect.click()
        await launched.page.getByRole('option', { name: 'Admin', exact: true }).click()
        await expect(memberRow(launched.page, 'Mason Member')).toContainText('Admin')
        await expect(launched.page.getByRole('status')).toHaveText(
          'Updated the role of Mason Member.'
        )

        await roleSelect.click()
        await launched.page.getByRole('option', { name: 'Member', exact: true }).click()
        await expect(memberRow(launched.page, 'Mason Member')).toContainText('Member')

        await launched.page.getByRole('button', { name: 'Remove member Ada Admin' }).click()
        const removalDialog = launched.page.getByRole('dialog', { name: 'Remove Ada Admin?' })
        await removalDialog.getByRole('button', { name: 'Remove', exact: true }).click()
        await expect(launched.page.getByText('Ada Admin', { exact: true })).toHaveCount(0)

        await expect(
          launched.page.getByRole('textbox', { name: 'Organization name', exact: true })
        ).toHaveCount(0)
        await launched.page
          .getByRole('navigation', { name: 'Settings' })
          .getByRole('button', { name: 'Organization details', exact: true })
          .click()

        const renamedOrganization = 'Renamed Membership Studio'
        const organizationName = launched.page.getByRole('textbox', {
          name: 'Organization name',
          exact: true
        })
        await expect(organizationName).toBeEditable()
        await expect(
          launched.page.getByRole('button', { name: 'Apply organization rename' })
        ).toBeVisible()
        await expect(
          launched.page.getByRole('button', { name: 'Discard organization rename' })
        ).toBeVisible()
        await organizationName.fill(`  ${renamedOrganization}  `)
        await launched.page.getByRole('button', { name: 'Apply organization rename' }).click()
        await expect.poll(() => activeProjectionRequestCount).toBeGreaterThanOrEqual(3)
        releasePreWriteRefresh()
        await expect.poll(() => preWriteRefreshCompleted).toBe(true)
        const settingsSidebar = launched.page.getByRole('complementary')
        await expect(settingsSidebar.getByText(renamedOrganization, { exact: true })).toBeVisible()
        await expect(launched.page.getByText('The action failed. Try again.')).toHaveCount(0)

        await settingsSidebar.getByRole('button', { name: 'All organizations' }).click()
        await expect(
          launched.page.getByRole('heading', { name: 'Select an organization' })
        ).toBeVisible()
        const renamedOrganizationButton = launched.page.getByRole('button', {
          name: new RegExp(renamedOrganization)
        })
        await expect(renamedOrganizationButton).toBeVisible()
        await renamedOrganizationButton.click()
        await expect(
          launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
        ).toBeVisible()
      } finally {
        releasePreWriteRefresh()
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
      await deleteAuthUser(authHarness, adminId)
      await deleteAuthUser(authHarness, memberId)
      await deleteAuthUser(authHarness, ownerId)
    }
  }
)

test(
  'an Admin manages members and leaves despite a failed post-commit projection',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(90_000)
    test.skip(!authHarness || !mailpitHarness, 'requires disposable Supabase Auth and Mailpit')
    if (!authHarness || !mailpitHarness) return

    const adminIdentity = uniqueAuthIdentity('members-admin-management')
    const memberIdentity = uniqueAuthIdentity('members-admin-member')
    const inviteeIdentity = uniqueAuthIdentity('members-admin-invitee')
    const adminId = await createAuthUser(authHarness, adminIdentity, true)
    const memberId = await createAuthUser(authHarness, memberIdentity, true)
    const organization = await seedOrganizationWithMembership(adminId, {
      name: 'Admin Management Studio',
      role: 'admin',
      profileDisplayName: 'Aria Admin'
    })
    await seedProfile(memberId, 'Miles Member')
    await seedActiveMembership(organization.id, memberId, 'member')
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-members-admin-management-'))

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await signIn(launched.page, adminIdentity)
        await openSettingsSectionFromUserMenu(launched.page, 'Members')

        const settingsMain = launched.page.getByRole('main')
        const settingsNavigation = launched.page.getByRole('navigation', { name: 'Settings' })
        await expect(settingsMain.getByText('Organization name', { exact: true })).toHaveCount(0)
        await settingsNavigation
          .getByRole('button', { name: 'Organization details', exact: true })
          .click()
        await expect(
          settingsMain.getByRole('heading', { name: 'Organization details', exact: true })
        ).toBeVisible()
        await expect(
          settingsMain.getByText('Admin Management Studio', { exact: true })
        ).toBeVisible()
        await expect(
          settingsMain.getByRole('textbox', { name: 'Organization name', exact: true })
        ).toHaveCount(0)
        await expect(
          settingsMain.getByRole('button', { name: 'Apply organization rename' })
        ).toHaveCount(0)
        await expect(
          settingsMain.getByRole('button', { name: 'Discard organization rename' })
        ).toHaveCount(0)
        await settingsNavigation.getByRole('button', { name: 'Members', exact: true }).click()
        await expect(
          settingsMain.getByRole('heading', { name: 'Members', exact: true })
        ).toBeVisible()
        await expect(launched.page.getByRole('combobox', { name: /Change role/ })).toHaveCount(0)
        await expect(
          launched.page.getByRole('button', { name: 'Remove member Miles Member' })
        ).toBeVisible()

        const pendingTab = launched.page.getByRole('tab', { name: /Pending invitations/ })
        await pendingTab.click()
        const messagesBeforeInvitation = await readMailpitMessageIds(mailpitHarness)
        await launched.page.getByRole('button', { name: 'Invite member' }).click()
        const invitationDialog = launched.page.getByRole('dialog', { name: 'Invite member' })
        await invitationDialog.getByLabel('Email').fill(inviteeIdentity.email)
        await invitationDialog.getByRole('button', { name: 'Send invitation' }).click()
        await waitForRegistrationMessage(
          mailpitHarness,
          messagesBeforeInvitation,
          inviteeIdentity.email
        )
        const pendingPanel = launched.page.getByRole('tabpanel', {
          name: 'Pending invitations'
        })
        await expect(pendingPanel.getByText(inviteeIdentity.email, { exact: true })).toBeVisible()
        await pendingPanel
          .getByRole('button', { name: `Revoke invitation to ${inviteeIdentity.email}` })
          .click()
        await launched.page
          .getByRole('dialog', { name: 'Revoke' })
          .getByRole('button', { name: 'Revoke', exact: true })
          .click()
        await expect(pendingPanel.getByText(inviteeIdentity.email, { exact: true })).toHaveCount(0)

        await launched.page.getByRole('tab', { name: 'Members', exact: true }).click()
        await launched.page.getByRole('button', { name: 'Remove member Miles Member' }).click()
        await launched.page
          .getByRole('dialog', { name: 'Remove Miles Member?' })
          .getByRole('button', { name: 'Remove', exact: true })
          .click()
        await expect(launched.page.getByText('Miles Member', { exact: true })).toHaveCount(0)
        await launched.page.route(
          '**/rest/v1/memberships*',
          (route) =>
            route.fulfill({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({ message: 'post-leave projection failed' })
            }),
          { times: 1 }
        )

        await launched.page.getByRole('button', { name: 'Aria Admin leave organization' }).click()
        await launched.page
          .getByRole('dialog', { name: 'Leave "Admin Management Studio"?' })
          .getByRole('button', { name: 'Leave', exact: true })
          .click()
        await expect(
          launched.page.getByRole('heading', { name: 'Select an organization' })
        ).toBeVisible()
        await expect(
          launched.page.getByRole('button', { name: /Admin Management Studio/ })
        ).toHaveCount(0)
        await expect(launched.page.getByText('The action failed. Try again.')).toHaveCount(0)
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
      await deleteAuthUser(authHarness, memberId)
      await deleteAuthUser(authHarness, adminId)
    }
  }
)

test('a timed-out Revoke Invitation command is sent once and reconciled before a safe retry', async () => {
  test.setTimeout(90_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const ownerIdentity = uniqueAuthIdentity('members-command-timeout-owner')
  const ownerId = await createAuthUser(authHarness, ownerIdentity, true)
  await seedOrganizationWithMembership(ownerId, {
    name: 'Command Timeout Studio',
    profileDisplayName: 'Taylor Owner'
  })
  const invitee = uniqueAuthIdentity('members-command-timeout-invitee')
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-members-command-timeout-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await signIn(launched.page, ownerIdentity)
      await openSettingsSectionFromUserMenu(launched.page, 'Members')
      await launched.page.getByRole('tab', { name: /Pending invitations/ }).click()

      await launched.page.getByRole('button', { name: 'Invite member' }).click()
      const invitationDialog = launched.page.getByRole('dialog', { name: 'Invite member' })
      await invitationDialog.getByLabel('Email').fill(invitee.email)
      await invitationDialog.getByRole('button', { name: 'Send invitation' }).click()
      await expect(launched.page.getByRole('status')).toHaveText(
        `Invitation sent to ${invitee.email}`
      )
      const pendingPanel = launched.page.getByRole('tabpanel', {
        name: 'Pending invitations'
      })
      const revokeButton = pendingPanel.getByRole('button', {
        name: `Revoke invitation to ${invitee.email}`
      })
      await expect(revokeButton).toBeVisible()

      let commandRequestCount = 0
      let membershipReadCount = 0
      let membersReadCount = 0
      let invitationsReadCount = 0
      await launched.page.route('**/rest/v1/memberships*', async (route) => {
        const select = new URL(route.request().url()).searchParams.get('select')
        if (select?.includes('organizations')) membershipReadCount += 1
        else membersReadCount += 1
        await route.continue()
      })
      await launched.page.route('**/rest/v1/invitations*', async (route) => {
        invitationsReadCount += 1
        await route.continue()
      })
      await launched.page.route(
        /\/identity\/organizations\/[^/]+\/invitations\/[^/]+\/revoke$/,
        async (route) => {
          commandRequestCount += 1
          await delay(16_000)
          void route.abort('timedout').catch(() => undefined)
        }
      )

      await revokeButton.click()
      const revokeDialog = launched.page.getByRole('dialog', { name: 'Revoke' })
      const commandStartedAt = Date.now()
      await revokeDialog.getByRole('button', { name: 'Revoke', exact: true }).click()
      await expect.poll(() => commandRequestCount).toBe(1)

      const settingsSidebar = launched.page.getByRole('complementary')
      await expect(
        launched.page.getByRole('button', { name: 'Back to app', includeHidden: true })
      ).toBeDisabled()
      await expect(
        launched.page.getByRole('button', { name: 'Profile', includeHidden: true })
      ).toBeDisabled()
      await expect(
        launched.page.getByRole('button', { name: 'All organizations', includeHidden: true })
      ).toBeDisabled()
      await requestOrdinaryWindowClose(launched.electronApp)
      await expectMainWindowCount(launched.electronApp, 1)

      await expect(revokeDialog.getByRole('button', { name: 'Revoke', exact: true })).toBeDisabled()
      expect(commandRequestCount).toBe(1)
      await expect(
        launched.page.getByText(
          'The command was not applied. The current state is refreshed; retry only if the action is still available.'
        )
      ).toBeVisible({ timeout: 20_000 })
      expect(Date.now() - commandStartedAt).toBeGreaterThanOrEqual(14_500)
      await expect(revokeDialog).toHaveCount(0)
      await expect(revokeButton).toBeEnabled()
      await expect(settingsSidebar.getByRole('button', { name: 'Profile' })).toBeEnabled()
      expect(commandRequestCount).toBe(1)
      expect(membershipReadCount).toBeGreaterThanOrEqual(1)
      expect(membersReadCount).toBeGreaterThanOrEqual(1)
      expect(invitationsReadCount).toBeGreaterThanOrEqual(1)
    } finally {
      await launched.page.unrouteAll({ behavior: 'ignoreErrors' })
      await forceCloseTestApp(launched.electronApp)
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, ownerId)
  }
})

test('a committed Invitation is confirmed by authoritative state after its response times out', async () => {
  test.setTimeout(90_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const ownerIdentity = uniqueAuthIdentity('members-command-committed-owner')
  const ownerId = await createAuthUser(authHarness, ownerIdentity, true)
  await seedOrganizationWithMembership(ownerId, {
    name: 'Committed Command Studio',
    profileDisplayName: 'Casey Owner'
  })
  const invitee = uniqueAuthIdentity('members-command-committed-invitee')
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-members-command-committed-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await signIn(launched.page, ownerIdentity)
      await openSettingsSectionFromUserMenu(launched.page, 'Members')
      const pendingTab = launched.page.getByRole('tab', { name: /Pending invitations/ })
      await pendingTab.click()

      let commandRequestCount = 0
      let serverCommitted = false
      let membershipReadCount = 0
      let membersReadCount = 0
      let invitationsReadCount = 0
      await launched.page.route('**/rest/v1/memberships*', async (route) => {
        const select = new URL(route.request().url()).searchParams.get('select')
        if (select?.includes('organizations')) membershipReadCount += 1
        else membersReadCount += 1
        await route.continue()
      })
      await launched.page.route('**/rest/v1/invitations*', async (route) => {
        invitationsReadCount += 1
        await route.continue()
      })
      await launched.page.route(/\/identity\/organizations\/[^/]+\/invitations$/, async (route) => {
        commandRequestCount += 1
        const response = await route.fetch()
        serverCommitted = true
        await delay(16_000)
        void route.fulfill({ response }).catch(() => undefined)
      })

      await launched.page.getByRole('button', { name: 'Invite member' }).click()
      const invitationDialog = launched.page.getByRole('dialog', { name: 'Invite member' })
      await invitationDialog.getByLabel('Email').fill(invitee.email)
      const commandStartedAt = Date.now()
      await invitationDialog.getByRole('button', { name: 'Send invitation' }).click()
      await expect.poll(() => serverCommitted).toBe(true)
      expect(commandRequestCount).toBe(1)

      await expect(invitationDialog).toHaveCount(0, { timeout: 20_000 })
      expect(Date.now() - commandStartedAt).toBeGreaterThanOrEqual(14_500)
      await expect(launched.page.getByRole('status')).toHaveText(
        `Invitation sent to ${invitee.email}`
      )
      await expect(launched.page.getByText(invitee.email, { exact: true })).toBeVisible()
      await expect(pendingTab).toContainText('1')
      expect(commandRequestCount).toBe(1)
      expect(membershipReadCount).toBeGreaterThanOrEqual(1)
      expect(membersReadCount).toBeGreaterThanOrEqual(1)
      expect(invitationsReadCount).toBeGreaterThanOrEqual(1)
    } finally {
      await launched.page.unrouteAll({ behavior: 'ignoreErrors' })
      await forceCloseTestApp(launched.electronApp)
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, ownerId)
  }
})

test('a timed-out command with failed reconciliation stays unknown until Check again succeeds', async () => {
  test.setTimeout(90_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const ownerIdentity = uniqueAuthIdentity('members-command-unknown-owner')
  const ownerId = await createAuthUser(authHarness, ownerIdentity, true)
  await seedOrganizationWithMembership(ownerId, {
    name: 'Unknown Command Studio',
    profileDisplayName: 'Jordan Owner'
  })
  const invitee = uniqueAuthIdentity('members-command-unknown-invitee')
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-members-command-unknown-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await signIn(launched.page, ownerIdentity)
      await openSettingsSectionFromUserMenu(launched.page, 'Members')
      await launched.page.getByRole('tab', { name: /Pending invitations/ }).click()

      await launched.page.getByRole('button', { name: 'Invite member' }).click()
      const invitationDialog = launched.page.getByRole('dialog', { name: 'Invite member' })
      await invitationDialog.getByLabel('Email').fill(invitee.email)
      await invitationDialog.getByRole('button', { name: 'Send invitation' }).click()
      await expect(launched.page.getByRole('status')).toHaveText(
        `Invitation sent to ${invitee.email}`
      )
      const pendingPanel = launched.page.getByRole('tabpanel', {
        name: 'Pending invitations'
      })
      const revokeButton = pendingPanel.getByRole('button', {
        name: `Revoke invitation to ${invitee.email}`
      })
      await expect(revokeButton).toBeVisible()

      let commandRequestCount = 0
      let projectionUnavailable = false
      let membershipReadCount = 0
      let membersReadCount = 0
      let invitationsReadCount = 0
      await launched.page.route('**/rest/v1/memberships*', async (route) => {
        const select = new URL(route.request().url()).searchParams.get('select')
        if (select?.includes('organizations')) membershipReadCount += 1
        else membersReadCount += 1
        if (projectionUnavailable) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'controlled Membership reconciliation failure' })
          })
          return
        }
        await route.continue()
      })
      await launched.page.route('**/rest/v1/invitations*', async (route) => {
        invitationsReadCount += 1
        if (projectionUnavailable) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'controlled Invitation reconciliation failure' })
          })
          return
        }
        await route.continue()
      })
      await launched.page.route(
        /\/identity\/organizations\/[^/]+\/invitations\/[^/]+\/revoke$/,
        async (route) => {
          commandRequestCount += 1
          await delay(16_000)
          void route.abort('timedout').catch(() => undefined)
        }
      )

      await revokeButton.click()
      const revokeDialog = launched.page.getByRole('dialog', { name: 'Revoke' })
      const commandStartedAt = Date.now()
      await revokeDialog.getByRole('button', { name: 'Revoke', exact: true }).click()
      await expect.poll(() => commandRequestCount).toBe(1)
      projectionUnavailable = true

      await expect(revokeDialog).toHaveCount(0, { timeout: 20_000 })
      expect(Date.now() - commandStartedAt).toBeGreaterThanOrEqual(14_500)
      await expect(
        launched.page.getByText(
          'The result is not confirmed yet. Check authoritative state before continuing.'
        )
      ).toBeVisible()
      const checkAgain = launched.page.getByRole('button', {
        name: 'Check the command result again'
      })
      await expect(checkAgain).toBeEnabled()
      await expect(launched.page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
      const settingsSidebar = launched.page.getByRole('complementary')
      await expect(settingsSidebar.getByRole('button', { name: 'Back to app' })).toBeDisabled()
      await expect(settingsSidebar.getByRole('button', { name: 'Profile' })).toBeDisabled()
      await expect(
        settingsSidebar.getByRole('button', { name: 'All organizations' })
      ).toBeDisabled()
      expect(commandRequestCount).toBe(1)
      expect(membershipReadCount).toBeGreaterThanOrEqual(1)
      expect(membersReadCount).toBeGreaterThanOrEqual(1)
      expect(invitationsReadCount).toBeGreaterThanOrEqual(1)

      projectionUnavailable = false
      await checkAgain.click()
      await expect(
        launched.page.getByText(
          'The command was not applied. The current state is refreshed; retry only if the action is still available.'
        )
      ).toBeVisible()
      await launched.page.getByRole('tab', { name: /Pending invitations/ }).click()
      await expect(revokeButton).toBeEnabled()
      await expect(settingsSidebar.getByRole('button', { name: 'Profile' })).toBeEnabled()
      expect(commandRequestCount).toBe(1)
    } finally {
      await launched.page.unrouteAll({ behavior: 'ignoreErrors' })
      await forceCloseTestApp(launched.electronApp)
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    await deleteAuthUser(authHarness, ownerId)
  }
})

test('a delayed active-membership rejection keeps Create Invitation unknown after reconciliation', async () => {
  test.setTimeout(90_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const ownerIdentity = uniqueAuthIdentity('members-command-active-member-owner')
  const ownerId = await createAuthUser(authHarness, ownerIdentity, true)
  const organization = await seedOrganizationWithMembership(ownerId, {
    name: 'Active Member Command Studio',
    profileDisplayName: 'Morgan Owner'
  })
  const memberIdentity = uniqueAuthIdentity('members-command-active-member-target')
  const memberId = await createAuthUser(authHarness, memberIdentity, true)
  await seedProfile(memberId, 'Avery Member')
  await seedActiveMembership(organization.id, memberId, 'member')
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-members-command-active-member-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await signIn(launched.page, ownerIdentity)
      await openSettingsSectionFromUserMenu(launched.page, 'Members')
      await launched.page.getByRole('tab', { name: /Pending invitations/ }).click()

      let commandRequestCount = 0
      let delayedResponseStatus: number | undefined
      let delayedResponseCode: string | undefined
      let membershipReadCount = 0
      let membersReadCount = 0
      let invitationsReadCount = 0
      await launched.page.route('**/rest/v1/memberships*', async (route) => {
        const select = new URL(route.request().url()).searchParams.get('select')
        if (select?.includes('organizations')) membershipReadCount += 1
        else membersReadCount += 1
        await route.continue()
      })
      await launched.page.route('**/rest/v1/invitations*', async (route) => {
        invitationsReadCount += 1
        await route.continue()
      })
      await launched.page.route(/\/identity\/organizations\/[^/]+\/invitations$/, async (route) => {
        commandRequestCount += 1
        const response = await route.fetch()
        const body = await response.text()
        delayedResponseStatus = response.status()
        const payload = JSON.parse(body) as { readonly error?: unknown }
        delayedResponseCode = typeof payload.error === 'string' ? payload.error : undefined
        await delay(16_000)
        void route
          .fulfill({ status: response.status(), headers: response.headers(), body })
          .catch(() => undefined)
      })

      await launched.page.getByRole('button', { name: 'Invite member' }).click()
      const invitationDialog = launched.page.getByRole('dialog', { name: 'Invite member' })
      await invitationDialog.getByLabel('Email').fill(memberIdentity.email)
      const commandStartedAt = Date.now()
      await invitationDialog.getByRole('button', { name: 'Send invitation' }).click()
      await expect.poll(() => delayedResponseCode).toBe('active_membership_exists')
      expect(delayedResponseStatus).toBe(409)
      expect(commandRequestCount).toBe(1)

      await expect(invitationDialog).toHaveCount(0, { timeout: 20_000 })
      expect(Date.now() - commandStartedAt).toBeGreaterThanOrEqual(14_500)
      await expect(
        launched.page.getByText(
          'The result is not confirmed yet. Check authoritative state before continuing.'
        )
      ).toBeVisible()
      const checkAgain = launched.page.getByRole('button', {
        name: 'Check the command result again'
      })
      await expect(checkAgain).toBeEnabled()
      await expect(launched.page.getByRole('button', { name: 'Invite member' })).toBeDisabled()
      const settingsSidebar = launched.page.getByRole('complementary')
      await expect(settingsSidebar.getByRole('button', { name: 'Profile' })).toBeDisabled()
      expect(commandRequestCount).toBe(1)
      expect(membershipReadCount).toBeGreaterThanOrEqual(1)
      expect(membersReadCount).toBeGreaterThanOrEqual(1)
      expect(invitationsReadCount).toBeGreaterThanOrEqual(1)

      const membershipReadsBeforeCheck = membershipReadCount
      const memberReadsBeforeCheck = membersReadCount
      const invitationReadsBeforeCheck = invitationsReadCount
      await checkAgain.click()
      await expect.poll(() => membershipReadCount).toBeGreaterThan(membershipReadsBeforeCheck)
      await expect.poll(() => membersReadCount).toBeGreaterThan(memberReadsBeforeCheck)
      await expect.poll(() => invitationsReadCount).toBeGreaterThan(invitationReadsBeforeCheck)
      await expect(
        launched.page.getByText(
          'The result is not confirmed yet. Check authoritative state before continuing.'
        )
      ).toBeVisible()
      await expect(checkAgain).toBeEnabled()
      await expect(launched.page.getByRole('button', { name: 'Invite member' })).toBeDisabled()
      await expect(settingsSidebar.getByRole('button', { name: 'Profile' })).toBeDisabled()
      expect(commandRequestCount).toBe(1)
    } finally {
      await launched.page.unrouteAll({ behavior: 'ignoreErrors' })
      await forceCloseTestApp(launched.electronApp)
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, memberId)
    await deleteAuthUser(authHarness, ownerId)
  }
})
