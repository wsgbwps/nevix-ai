import { expect, test, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAuthUser,
  deleteAuthUser,
  readAuthHarnessConfig,
  signInOutsideDesktop,
  uniqueAuthIdentity
} from '../auth/helpers/supabase-auth'
import {
  expectMainWindowCount,
  launchTestApp,
  openSettingsFromUserMenu,
  requestOrdinaryWindowClose,
  signOutFromUserMenu
} from '../helpers/electron-app'
import {
  seedActiveMembership,
  seedAuditLogEntries,
  seedOrganizationWithMembership,
  seedProfile,
  updateMembershipRole
} from './helpers/organization-seed'

const authHarness = readAuthHarnessConfig()

async function signIn(
  page: Page,
  identity: { readonly email: string; readonly password: string }
): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible()
  await page.getByLabel('Email').fill(identity.email)
  await page.getByLabel('Password', { exact: true }).fill(identity.password)
  await page.getByRole('button', { name: 'Sign in' }).click()

  const home = page.getByRole('heading', { name: 'Create with Nevix AI' })
  const startupRetry = page.getByRole('button', { name: 'Try again', exact: true })
  await expect(home.or(startupRetry)).toBeVisible()
  if (await startupRetry.isVisible()) await startupRetry.click()
  await expect(home).toBeVisible()
}

test(
  'an Owner views snapshot actor, action, target, and time in a date-grouped Audit Log timeline',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(90_000)
    test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
    if (!authHarness) return

    const identity = uniqueAuthIdentity('audit-log-timeline')
    const userId = await createAuthUser(authHarness, identity, true)
    const organization = await seedOrganizationWithMembership(userId, {
      name: 'Audit Timeline Studio'
    })
    const occurredAt = new Date().toISOString()
    await seedAuditLogEntries(organization.id, [
      {
        actorUserId: userId,
        actorDisplayName: 'Morgan Lee',
        targetUserId: crypto.randomUUID(),
        targetDisplayName: 'Rui Chen',
        action: 'member_removed',
        metadata: { reason: 'test fixture' },
        createdAt: occurredAt
      },
      {
        actorUserId: userId,
        actorDisplayName: 'Invitation Accepter',
        targetUserId: userId,
        targetDisplayName: 'Accepted Member Snapshot',
        action: 'invitation_accepted',
        metadata: { email: 'accepted-recipient@nevix.test' },
        createdAt: occurredAt
      }
    ])
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-audit-log-timeline-'))

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await signIn(launched.page, identity)
        await expect(
          launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
        ).toBeVisible()

        await openSettingsFromUserMenu(launched.page)
        const settingsNavigation = launched.page.getByRole('navigation', { name: 'Settings' })
        await expect(settingsNavigation.getByText('Organization', { exact: true })).toBeVisible()
        await settingsNavigation.getByRole('button', { name: 'Audit log' }).click()

        await expect(launched.page.getByRole('heading', { name: 'Audit log' })).toBeVisible()
        await expect(launched.page.getByRole('heading', { name: 'Today' })).toBeVisible()
        const timelineEntry = launched.page.getByRole('listitem').filter({ hasText: 'Morgan Lee' })
        await expect(timelineEntry).toContainText('Removed member')
        await expect(timelineEntry).toContainText('Rui Chen')
        const renderedDateTime = await timelineEntry.locator('time').getAttribute('dateTime')
        expect(renderedDateTime).not.toBeNull()
        expect(new Date(renderedDateTime as string).toISOString()).toBe(occurredAt)

        const acceptedInvitationEntry = launched.page
          .getByRole('listitem')
          .filter({ hasText: 'Invitation accepted' })
        await expect(acceptedInvitationEntry).toContainText('accepted-recipient@nevix.test')
        await expect(acceptedInvitationEntry).not.toContainText('Accepted Member Snapshot')
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
      await deleteAuthUser(authHarness, userId)
    }
  }
)

test('an Admin filters the Organization Audit Log by action', { tag: '@smoke' }, async () => {
  test.setTimeout(90_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('audit-log-filter')
  const userId = await createAuthUser(authHarness, identity, true)
  const organization = await seedOrganizationWithMembership(userId, {
    name: 'Audit Filter Studio',
    role: 'admin'
  })
  await seedAuditLogEntries(organization.id, [
    {
      actorUserId: userId,
      actorDisplayName: 'Member Leaver',
      action: 'membership_left'
    },
    {
      actorUserId: userId,
      actorDisplayName: 'Owner Snapshot',
      targetUserId: crypto.randomUUID(),
      targetDisplayName: 'Promoted Admin',
      action: 'admin_promoted'
    },
    {
      actorUserId: userId,
      actorDisplayName: 'Owner Snapshot',
      targetUserId: crypto.randomUUID(),
      targetDisplayName: 'Demoted Admin',
      action: 'admin_demoted'
    },
    {
      actorUserId: userId,
      actorDisplayName: 'Owner Snapshot',
      targetUserId: crypto.randomUUID(),
      targetDisplayName: 'Removed Admin',
      action: 'admin_removed'
    },
    {
      actorUserId: userId,
      actorDisplayName: 'Settings Editor',
      action: 'organization_settings_updated'
    },
    {
      actorUserId: userId,
      actorDisplayName: 'Alex Park',
      action: 'invitation_created',
      metadata: { email: 'invitee@nevix.test' }
    }
  ])
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-audit-log-filter-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await signIn(launched.page, identity)
      await openSettingsFromUserMenu(launched.page)
      await launched.page
        .getByRole('navigation', { name: 'Settings' })
        .getByRole('button', { name: 'Audit log' })
        .click()

      await expect(launched.page.getByText('Invitation created')).toBeVisible()
      await expect(
        launched.page.getByRole('listitem').filter({ hasText: 'Invitation created' })
      ).toContainText('invitee@nevix.test')
      await launched.page.getByRole('combobox', { name: 'All events' }).click()
      for (const action of [
        'Left organization',
        'Promoted to admin',
        'Demoted from admin',
        'Removed admin',
        'Updated organization settings'
      ]) {
        await expect(launched.page.getByRole('option', { name: action })).toBeVisible()
      }
      await launched.page.getByRole('option', { name: 'Promoted to admin' }).click()

      await expect(launched.page.getByText('Promoted Admin')).toBeVisible()
      await expect(launched.page.getByText('Demoted Admin')).toHaveCount(0)
      await expect(launched.page.getByText('Removed Admin')).toHaveCount(0)
      await expect(launched.page.getByText('Invitation created')).toHaveCount(0)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, userId)
  }
})

test(
  'Audit Log navigation preserves trusted Session IPC and real logout across restart',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(90_000)
    test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
    if (!authHarness) return

    const identity = uniqueAuthIdentity('audit-log-session-ipc')
    const userId = await createAuthUser(authHarness, identity, true)
    await seedOrganizationWithMembership(userId, { name: 'Audit Session IPC Studio' })
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-audit-log-session-ipc-'))

    try {
      let launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await signIn(launched.page, identity)
        await openSettingsFromUserMenu(launched.page)
        const settingsNavigation = launched.page.getByRole('navigation', { name: 'Settings' })
        await settingsNavigation.getByRole('button', { name: 'Audit log' }).click()

        expect(await launched.page.evaluate(() => window.location.hash)).toBe('')
        const sessionRead = await launched.page.evaluate(() =>
          window.api.invoke('authentication:read-session')
        )
        expect(['empty', 'session']).toContain(sessionRead.outcome)

        await launched.page.getByRole('button', { name: 'Back' }).click()
        await signOutFromUserMenu(launched.page)
        await expect(
          launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
        ).toBeVisible()
      } finally {
        await launched.electronApp.close()
      }

      launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await expect(
          launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
        ).toBeVisible()
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
  }
)

test(
  'an Owner exports every paginated Audit Log row to a local CSV file and receives feedback',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(120_000)
    test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
    if (!authHarness) return

    const identity = uniqueAuthIdentity('audit-log-export')
    const userId = await createAuthUser(authHarness, identity, true)
    const organization = await seedOrganizationWithMembership(userId, {
      name: 'Audit Export Studio'
    })
    const sharedTimestamp = new Date(Date.now() - 60_000).toISOString()
    const entries = Array.from({ length: 101 }, (_, index) => {
      const isAcceptedInvitation = index === 1
      return {
        actorUserId: userId,
        actorDisplayName: index === 0 ? '=CSV Actor 0' : `CSV Actor ${index}`,
        targetUserId: crypto.randomUUID(),
        targetDisplayName: isAcceptedInvitation
          ? 'Accepted Member Snapshot'
          : index === 0
            ? '@CSV Target 0'
            : `CSV Target ${index}`,
        action: isAcceptedInvitation ? 'invitation_accepted' : 'member_removed',
        metadata: isAcceptedInvitation
          ? { email: 'accepted-export-recipient@nevix.test', row: index }
          : { row: index },
        createdAt: sharedTimestamp
      }
    })
    await seedAuditLogEntries(organization.id, entries)
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-audit-log-export-user-'))
    const exportDirectory = await mkdtemp(join(tmpdir(), 'nevix-audit-log-export-file-'))
    const exportPath = join(exportDirectory, 'organization-audit-log.csv')

    try {
      const launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['en-US'],
        environment: { NEVIX_TEST_AUDIT_LOG_EXPORT_PATH: exportPath }
      })
      try {
        await signIn(launched.page, identity)
        await openSettingsFromUserMenu(launched.page)
        await launched.page
          .getByRole('navigation', { name: 'Settings' })
          .getByRole('button', { name: 'Audit log' })
          .click()

        await expect(launched.page.getByRole('listitem')).toHaveCount(101)

        let exportPageRequests = 0
        await launched.page.route(/\/rest\/v1\/audit_logs\?/, async (route) => {
          exportPageRequests += 1
          const response = await route.fetch()
          if (exportPageRequests === 1) {
            await seedAuditLogEntries(organization.id, [
              {
                actorUserId: userId,
                actorDisplayName: 'Inserted Between Pages',
                action: 'member_removed',
                createdAt: new Date(Date.parse(sharedTimestamp) + 1000).toISOString()
              }
            ])
          }
          await route.fulfill({ response })
        })

        await launched.page.getByRole('button', { name: 'Export' }).click()
        await expect(launched.page.getByRole('status')).toHaveText('Exported 101 entries.')
        expect(exportPageRequests).toBe(2)
      } finally {
        await launched.electronApp.close()
      }

      const csv = await readFile(exportPath, 'utf8')
      const rows = csv.trimEnd().split('\r\n')
      expect(rows).toHaveLength(102)
      expect(rows[0]).toBe('Time,Actor,Action,Target,Detail')
      const exportedActors = rows.slice(1).map((row) => row.split(',')[1])
      expect(new Set(exportedActors).size).toBe(101)
      expect(exportedActors).toContain("'=CSV Actor 0")
      expect(exportedActors).toContain('CSV Actor 100')
      expect(csv).toContain("'@CSV Target 0")
      expect(csv).toContain('Invitation accepted,accepted-export-recipient@nevix.test,')
      expect(csv).not.toContain('Accepted Member Snapshot')
      expect(csv).not.toContain('Inserted Between Pages')
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
      await rm(exportDirectory, { recursive: true, force: true })
      await deleteAuthUser(authHarness, userId)
    }
  }
)

test(
  'cancelled Audit export blocks Settings navigation and ordinary close only while active',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(90_000)
    test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
    if (!authHarness) return

    const identity = uniqueAuthIdentity('audit-log-export-cancel')
    const userId = await createAuthUser(authHarness, identity, true)
    const organization = await seedOrganizationWithMembership(userId, {
      name: 'Audit Export Cancel Studio'
    })
    await seedAuditLogEntries(organization.id, [
      {
        actorUserId: userId,
        actorDisplayName: 'Cancel Export Auditor',
        action: 'member_removed'
      }
    ])
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-audit-log-export-cancel-user-'))
    const exportDirectory = await mkdtemp(join(tmpdir(), 'nevix-audit-log-export-cancel-file-'))
    const exportPath = join(exportDirectory, 'cancelled-audit-log.csv')

    try {
      const launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['en-US'],
        environment: {
          NEVIX_TEST_AUDIT_LOG_CANCEL_DELAY_MS: '1500',
          NEVIX_TEST_AUDIT_LOG_EXPORT_PATH: exportPath
        }
      })
      try {
        await signIn(launched.page, identity)
        await openSettingsFromUserMenu(launched.page)
        const settingsNavigation = launched.page.getByRole('navigation', { name: 'Settings' })
        await settingsNavigation.getByRole('button', { name: 'Audit log' }).click()
        await expect(launched.page.getByText('Cancel Export Auditor')).toBeVisible()

        const backButton = launched.page.getByRole('button', { name: 'Back' })
        const profileSection = settingsNavigation.getByRole('button', { name: 'Profile' })
        const organizationPicker = launched.page.getByRole('button', { name: 'All organizations' })
        await launched.page.getByRole('button', { name: 'Export' }).click()

        await expect(backButton).toBeDisabled()
        await expect(profileSection).toBeDisabled()
        await expect(organizationPicker).toBeDisabled()
        await requestOrdinaryWindowClose(launched.electronApp)
        await expectMainWindowCount(launched.electronApp, 1)

        await expect(backButton).toBeEnabled({ timeout: 5_000 })
        await expect(profileSection).toBeEnabled()
        await expect(organizationPicker).toBeEnabled()
        await expect(launched.page.getByRole('status')).toHaveCount(0)
        await expect(readFile(exportPath, 'utf8')).rejects.toThrow(/ENOENT/)

        await profileSection.click()
        await expect(launched.page.getByRole('heading', { name: 'Profile' })).toBeVisible()
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await Promise.all([
        rm(userDataDir, { recursive: true, force: true }),
        rm(exportDirectory, { recursive: true, force: true })
      ])
      await deleteAuthUser(authHarness, userId)
    }
  }
)

test(
  'Membership unknown withholds mounted Audit rows until a successful retry',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(90_000)
    test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
    if (!authHarness) return

    const identity = uniqueAuthIdentity('audit-log-membership-error')
    const userId = await createAuthUser(authHarness, identity, true)
    const organization = await seedOrganizationWithMembership(userId, {
      name: 'Audit Membership Retry Studio'
    })
    await seedAuditLogEntries(organization.id, [
      {
        actorUserId: userId,
        actorDisplayName: 'Mounted Sensitive Auditor',
        action: 'member_removed'
      }
    ])
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-audit-log-membership-error-'))

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await signIn(launched.page, identity)
        await expect(
          launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
        ).toBeVisible()

        await openSettingsFromUserMenu(launched.page)
        const settingsNavigation = launched.page.getByRole('navigation', { name: 'Settings' })
        const auditLogSection = settingsNavigation.getByRole('button', { name: 'Audit log' })
        await auditLogSection.click()
        await expect(launched.page.getByText('Mounted Sensitive Auditor')).toBeVisible()

        let membershipUnavailable = true
        await launched.page.route(/\/rest\/v1\/memberships\?/, async (route) => {
          if (membershipUnavailable) {
            await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
            return
          }
          await route.continue()
        })
        let auditLogRequests = 0
        await launched.page.route(/\/rest\/v1\/audit_logs\?/, async (route) => {
          auditLogRequests += 1
          await route.continue()
        })

        await launched.page.getByRole('button', { name: 'Export' }).click()
        await expect(
          launched.page.getByText('Unable to verify your Audit Log access right now.')
        ).toBeVisible()
        await expect(launched.page.getByText('Mounted Sensitive Auditor')).toHaveCount(0)
        await expect(launched.page.getByRole('combobox', { name: 'All events' })).toHaveCount(0)
        await expect(launched.page.getByRole('button', { name: 'Export' })).toHaveCount(0)
        await expect(auditLogSection).toHaveAttribute('aria-pressed', 'true')
        expect(auditLogRequests).toBe(0)

        membershipUnavailable = false
        const auditLogResponse = launched.page.waitForResponse(
          (response) => response.url().includes('/rest/v1/audit_logs?') && response.ok()
        )
        await launched.page.getByRole('button', { name: 'Try again' }).click()
        await auditLogResponse

        await expect(
          launched.page.getByText('Unable to verify your Audit Log access right now.')
        ).toHaveCount(0)
        await expect(launched.page.getByText('Mounted Sensitive Auditor')).toBeVisible()
        expect(auditLogRequests).toBe(1)
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
      await deleteAuthUser(authHarness, userId)
    }
  }
)

test(
  'an authorized User stays in Audit Log with a retryable data error when the row request fails',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(90_000)
    test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
    if (!authHarness) return

    const identity = uniqueAuthIdentity('audit-log-data-error')
    const userId = await createAuthUser(authHarness, identity, true)
    const organization = await seedOrganizationWithMembership(userId, {
      name: 'Audit Data Retry Studio'
    })
    await seedAuditLogEntries(organization.id, [
      {
        actorUserId: userId,
        actorDisplayName: 'Recovered Auditor',
        action: 'member_removed'
      }
    ])
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-audit-log-data-error-'))

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await signIn(launched.page, identity)
        let auditDataUnavailable = true
        let releaseDataRetry = (): void => undefined
        const dataRetryMayContinue = new Promise<void>((resolve) => {
          releaseDataRetry = resolve
        })
        await launched.page.route(/\/rest\/v1\/audit_logs\?/, async (route) => {
          if (auditDataUnavailable) {
            await route.fulfill({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({ message: 'temporary Audit Log data failure' })
            })
            return
          }
          await dataRetryMayContinue
          await route.continue()
        })

        await openSettingsFromUserMenu(launched.page)
        const settingsNavigation = launched.page.getByRole('navigation', { name: 'Settings' })
        await settingsNavigation.getByRole('button', { name: 'Audit log' }).click()

        await expect(launched.page.getByRole('heading', { name: 'Audit log' })).toBeVisible()
        await expect(
          launched.page.getByText('Unable to load the Audit Log right now.')
        ).toBeVisible()
        await expect(
          launched.page.getByText('Unable to verify your Audit Log access right now.')
        ).toHaveCount(0)
        await expect(launched.page.getByRole('listitem')).toHaveCount(0)
        await expect(settingsNavigation.getByRole('button', { name: 'Audit log' })).toHaveAttribute(
          'aria-pressed',
          'true'
        )

        auditDataUnavailable = false
        const auditLogRequest = launched.page.waitForRequest((request) =>
          request.url().includes('/rest/v1/audit_logs?')
        )
        const auditLogResponse = launched.page.waitForResponse(
          (response) => response.url().includes('/rest/v1/audit_logs?') && response.ok()
        )
        await launched.page.getByRole('button', { name: 'Try again' }).click()
        await auditLogRequest
        await expect(
          launched.page.getByText('Unable to load the Audit Log right now.')
        ).toBeVisible()
        releaseDataRetry()
        await auditLogResponse

        await expect(
          launched.page.getByText('Unable to load the Audit Log right now.')
        ).toHaveCount(0)
        await expect(launched.page.getByText('Recovered Auditor')).toBeVisible()
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
      await deleteAuthUser(authHarness, userId)
    }
  }
)

test(
  'fresh Membership confirmation replaces Audit Log with Members after permission loss',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(90_000)
    test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
    if (!authHarness) return

    const identity = uniqueAuthIdentity('audit-log-admin-demotion')
    const userId = await createAuthUser(authHarness, identity, true)
    const organization = await seedOrganizationWithMembership(userId, {
      name: 'Audit Demotion Studio',
      role: 'admin'
    })
    await seedAuditLogEntries(organization.id, [
      {
        actorUserId: userId,
        actorDisplayName: 'Mounted Demoted Auditor',
        action: 'member_removed'
      }
    ])
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-audit-log-admin-demotion-'))

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await signIn(launched.page, identity)
        await expect(
          launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
        ).toBeVisible()

        await openSettingsFromUserMenu(launched.page)
        const settingsNavigation = launched.page.getByRole('navigation', { name: 'Settings' })
        const auditLogSection = settingsNavigation.getByRole('button', { name: 'Audit log' })
        await auditLogSection.click()
        await expect(launched.page.getByText('Mounted Demoted Auditor')).toBeVisible()

        let auditLogRequests = 0
        await launched.page.route(/\/rest\/v1\/audit_logs\?/, async (route) => {
          auditLogRequests += 1
          await route.continue()
        })
        await updateMembershipRole(userId, organization.id, 'member')
        const membershipVerification = launched.page.waitForResponse(
          (response) => response.url().includes('/rest/v1/memberships?') && response.ok()
        )
        await launched.page.getByRole('button', { name: 'Export' }).click()
        await membershipVerification

        await expect(launched.page.getByText('Mounted Demoted Auditor')).toHaveCount(0)
        await expect(settingsNavigation.getByText('Audit log', { exact: true })).toHaveCount(0)
        await expect(settingsNavigation.getByRole('button', { name: 'Members' })).toHaveAttribute(
          'aria-pressed',
          'true'
        )
        await expect(launched.page.getByRole('heading', { name: 'Members' })).toBeVisible()
        await expect(launched.page.getByRole('heading', { name: 'Audit log' })).toHaveCount(0)
        expect(auditLogRequests).toBe(0)
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
      await deleteAuthUser(authHarness, userId)
    }
  }
)

test(
  'a Member has no Audit Log entry and its direct RLS read returns no Audit Log rows',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(90_000)
    test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
    if (!authHarness) return

    const ownerIdentity = uniqueAuthIdentity('audit-log-member-owner')
    const ownerId = await createAuthUser(authHarness, ownerIdentity, true)
    const organization = await seedOrganizationWithMembership(ownerId, {
      name: 'Audit Member Denial Studio'
    })
    await seedAuditLogEntries(organization.id, [
      {
        actorUserId: ownerId,
        actorDisplayName: 'Owner Snapshot',
        action: 'invitation_created'
      }
    ])
    const memberIdentity = uniqueAuthIdentity('audit-log-member')
    const memberId = await createAuthUser(authHarness, memberIdentity, true)
    await seedProfile(memberId)
    await seedActiveMembership(organization.id, memberId, 'member')
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-audit-log-member-'))

    try {
      const memberSession = await signInOutsideDesktop(authHarness, memberIdentity)
      const memberClient = createClient(authHarness.url, authHarness.publishableKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
        accessToken: async () => memberSession.access_token
      })
      const { data, error } = await memberClient
        .from('audit_logs')
        .select('id')
        .eq('organization_id', organization.id)
      expect(error).toBeNull()
      expect(data).toEqual([])

      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await signIn(launched.page, memberIdentity)
        await openSettingsFromUserMenu(launched.page)
        const settingsNavigation = launched.page.getByRole('navigation', { name: 'Settings' })
        await expect(settingsNavigation.getByRole('button', { name: 'Audit log' })).toHaveCount(0)
        await expect(launched.page.getByRole('heading', { name: 'Audit log' })).toHaveCount(0)
        await expect(
          launched.page.getByText('Unable to verify your Audit Log access right now.')
        ).toHaveCount(0)
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
