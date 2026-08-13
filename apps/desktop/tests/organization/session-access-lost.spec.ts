import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAuthUser,
  deleteAuthUser,
  readAuthHarnessConfig,
  uniqueAuthIdentity
} from '../auth/helpers/supabase-auth'
import { launchTestApp, openSettingsFromUserMenu } from '../helpers/electron-app'
import { endMembership, seedOrganizationWithMembership } from './helpers/organization-seed'

const authHarness = readAuthHarnessConfig()

const HOME_HEADING = 'Create with Nevix AI'
const PICKER_HEADING = 'Select an organization'
const ACCESS_LOST_DESCRIPTION =
  'Your membership has ended. If this was a mistake, ask an organization admin to invite you again.'

async function signIn(
  page: Page,
  identity: { readonly email: string; readonly password: string }
): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible()
  await page.getByLabel('Email').fill(identity.email)
  await page.getByLabel('Password', { exact: true }).fill(identity.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

async function expectBlockingAccessLostDialog(page: Page, organizationName: string): Promise<void> {
  const dialog = page.getByRole('dialog', {
    name: `You lost access to "${organizationName}"`
  })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(ACCESS_LOST_DESCRIPTION)
  await expect(dialog.getByRole('button', { name: 'Got it' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /close|cancel/i })).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
}

async function expectOrganizationSettingsUnmounted(page: Page, displayName: string): Promise<void> {
  await expect(
    page.getByRole('heading', { name: 'Members', exact: true, includeHidden: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole('button', {
      name: `${displayName} leave organization`,
      includeHidden: true
    })
  ).toHaveCount(0)
  await expect(page.getByText(displayName, { exact: true })).toHaveCount(0)
}

test(
  'a command denial confirms lost access before showing the remaining Organizations',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(90_000)
    test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
    if (!authHarness) return

    const identity = uniqueAuthIdentity('session-access-lost-command')
    const userId = await createAuthUser(authHarness, identity, true)
    const departedOrganization = await seedOrganizationWithMembership(userId, {
      name: 'Departed Studio',
      role: 'member',
      profileDisplayName: 'Mina Member'
    })
    await seedOrganizationWithMembership(userId, { name: 'Fallback Studio' })
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-session-access-lost-command-'))

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await signIn(launched.page, identity)
        await expect(launched.page.getByRole('heading', { name: PICKER_HEADING })).toBeVisible()
        await launched.page.getByRole('button', { name: /Departed Studio/ }).click()
        await expect(launched.page.getByRole('heading', { name: HOME_HEADING })).toBeVisible()
        await openSettingsFromUserMenu(launched.page)
        await expect(launched.page.getByText('Mina Member', { exact: true })).toBeVisible()

        await endMembership(userId, departedOrganization.id)
        await launched.page.getByRole('button', { name: 'Mina Member leave organization' }).click()
        await launched.page
          .getByRole('dialog', { name: 'Leave "Departed Studio"?' })
          .getByRole('button', { name: 'Leave', exact: true })
          .click()

        await expectBlockingAccessLostDialog(launched.page, 'Departed Studio')
        await expectOrganizationSettingsUnmounted(launched.page, 'Mina Member')
        await expect(
          launched.page.getByRole('textbox', {
            name: 'Organization name',
            exact: true,
            includeHidden: true
          })
        ).toHaveCount(0)

        await launched.page.getByRole('button', { name: 'Got it' }).click()
        await expect(launched.page.getByRole('heading', { name: PICKER_HEADING })).toBeVisible()
        await expect(launched.page.getByRole('button', { name: /Fallback Studio/ })).toBeVisible()
        await expect(launched.page.getByRole('button', { name: /Departed Studio/ })).toHaveCount(0)
        await expect(launched.page.getByRole('heading', { name: HOME_HEADING })).toHaveCount(0)
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
  'an RLS projection change confirms lost access before starting Organization onboarding',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(90_000)
    test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
    if (!authHarness) return

    const identity = uniqueAuthIdentity('session-access-lost-rls')
    const userId = await createAuthUser(authHarness, identity, true)
    const organization = await seedOrganizationWithMembership(userId, {
      name: 'Solo Studio',
      profileDisplayName: 'Sora Owner'
    })
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-session-access-lost-rls-'))

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await signIn(launched.page, identity)
        await expect(launched.page.getByRole('heading', { name: HOME_HEADING })).toBeVisible()

        await endMembership(userId, organization.id)
        await openSettingsFromUserMenu(launched.page)

        await expectBlockingAccessLostDialog(launched.page, 'Solo Studio')
        await expectOrganizationSettingsUnmounted(launched.page, 'Sora Owner')

        await launched.page.getByRole('button', { name: 'Got it' }).click()
        await expect(
          launched.page.getByRole('heading', { name: 'Create your first organization' })
        ).toBeVisible()
        await expect(launched.page.getByLabel('Organization name')).toBeVisible()
        await expect(
          launched.page.getByRole('heading', { name: 'What should we call you?' })
        ).toHaveCount(0)
        await expect(launched.page.getByLabel('Display name')).toHaveCount(0)
        await expect(launched.page.getByText('Solo Studio', { exact: true })).toHaveCount(0)
        await expect(launched.page.getByRole('heading', { name: HOME_HEADING })).toHaveCount(0)
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
      await deleteAuthUser(authHarness, userId)
    }
  }
)
