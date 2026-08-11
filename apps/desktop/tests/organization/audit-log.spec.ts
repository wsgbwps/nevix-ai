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
import { launchTestApp, openSettingsFromUserMenu } from '../helpers/electron-app'
import {
  seedActiveMembership,
  seedAuditLogEntries,
  seedOrganizationWithMembership
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
        await expect(settingsNavigation.getByText('Organization')).toBeVisible()
        await settingsNavigation.getByRole('link', { name: 'Audit log' }).click()

        await expect(launched.page.getByRole('heading', { name: 'Audit log' })).toBeVisible()
        await expect(launched.page.getByRole('heading', { name: 'Today' })).toBeVisible()
        const timelineEntry = launched.page.getByRole('listitem').filter({ hasText: 'Morgan Lee' })
        await expect(timelineEntry).toContainText('Removed member')
        await expect(timelineEntry).toContainText('Rui Chen')
        const renderedDateTime = await timelineEntry.locator('time').getAttribute('dateTime')
        expect(renderedDateTime).not.toBeNull()
        expect(new Date(renderedDateTime as string).toISOString()).toBe(occurredAt)
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
      actorDisplayName: 'Alex Park',
      targetUserId: crypto.randomUUID(),
      targetDisplayName: 'Sam Wu',
      action: 'member_removed'
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
        .getByRole('link', { name: 'Audit log' })
        .click()

      await expect(launched.page.getByText('Invitation created')).toBeVisible()
      await expect(
        launched.page.getByRole('listitem').filter({ hasText: 'Invitation created' })
      ).toContainText('invitee@nevix.test')
      await launched.page.getByRole('combobox', { name: 'All events' }).click()
      await launched.page.getByRole('option', { name: 'Removed member' }).click()

      await expect(launched.page.getByText('Sam Wu')).toBeVisible()
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
    const baseTimestamp = Date.now()
    const entries = Array.from({ length: 101 }, (_, index) => ({
      actorUserId: userId,
      actorDisplayName: index === 0 ? '=CSV Actor 0' : `CSV Actor ${index}`,
      targetUserId: crypto.randomUUID(),
      targetDisplayName: index === 0 ? '@CSV Target 0' : `CSV Target ${index}`,
      action: 'member_removed',
      metadata: { row: index },
      createdAt: new Date(baseTimestamp - index * 1000).toISOString()
    }))
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
          .getByRole('link', { name: 'Audit log' })
          .click()

        // Entry 100 comes from the second Data API page (the feature page size is 100).
        await expect(launched.page.getByText('CSV Actor 100')).toBeVisible()
        await launched.page.getByRole('button', { name: 'Export' }).click()
        await expect(launched.page.getByRole('status')).toHaveText('Exported 101 entries.')
      } finally {
        await launched.electronApp.close()
      }

      const csv = await readFile(exportPath, 'utf8')
      const rows = csv.trimEnd().split('\r\n')
      expect(rows).toHaveLength(102)
      expect(rows[0]).toBe('Time,Actor,Action,Target,Detail')
      expect(new Date(rows[1].split(',', 1)[0] ?? '').toISOString()).toBe(entries[0].createdAt)
      expect(rows[1]).toContain("'=CSV Actor 0")
      expect(rows[1]).toContain("'@CSV Target 0")
      expect(new Date(rows[101].split(',', 1)[0] ?? '').toISOString()).toBe(entries[100].createdAt)
      expect(rows[101]).toContain('CSV Actor 100')
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
      await rm(exportDirectory, { recursive: true, force: true })
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
        await expect(settingsNavigation.getByRole('link', { name: 'Audit log' })).toHaveCount(0)
        await expect(launched.page.getByRole('heading', { name: 'Audit log' })).toHaveCount(0)
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
