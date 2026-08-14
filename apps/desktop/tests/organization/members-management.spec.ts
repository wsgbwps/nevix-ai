import { expect, test, type Locator, type Page } from '@playwright/test'
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
import { launchTestApp, openSettingsFromUserMenu } from '../helpers/electron-app'
import {
  ageInvitationCodeBeyondCooldown,
  readPendingInvitationId,
  seedActiveMembership,
  seedOrganizationWithMembership,
  seedProfile
} from './helpers/organization-seed'

const authHarness = readAuthHarnessConfig()
const mailpitHarness = readMailpitHarnessConfig()

async function signIn(
  page: Page,
  identity: { readonly email: string; readonly password: string }
): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible()
  await page.getByLabel('Email').fill(identity.email)
  await page.getByLabel('Password', { exact: true }).fill(identity.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
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
        await openSettingsFromUserMenu(launched.page)

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
        await openSettingsFromUserMenu(launched.page)

        const pendingTab = launched.page.getByRole('tab', { name: /Pending invitations/ })
        await pendingTab.click()
        await expect(pendingTab).toContainText('0')

        const firstMessages = await readMailpitMessageIds(mailpitHarness)
        await launched.page.getByRole('button', { name: 'Invite member' }).click()
        const firstDialog = launched.page.getByRole('dialog', { name: 'Invite member' })
        await firstDialog.getByLabel('Email').fill(mixedCaseFirstInviteeEmail)
        await firstDialog.getByRole('button', { name: 'Send invitation' }).click()
        await expect(launched.page.getByRole('status')).toHaveText(
          `Invitation sent to ${mixedCaseFirstInviteeEmail}`
        )
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
        await openSettingsFromUserMenu(launched.page)
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
        await openSettingsFromUserMenu(launched.page)
        await expect.poll(() => activeProjectionRequestCount).toBe(1)

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
        await expect.poll(() => activeProjectionRequestCount).toBeGreaterThanOrEqual(2)
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
        await openSettingsFromUserMenu(launched.page)

        const settingsMain = launched.page.getByRole('main')
        await expect(settingsMain.getByText('Organization name', { exact: true })).toBeVisible()
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
