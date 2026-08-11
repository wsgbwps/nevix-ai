import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'
import {
  createAuthUser,
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
  ageInvitationCodeBeyondCooldown,
  expireInvitation,
  readInvitationAcceptanceState,
  seedProfile,
  seedOrganizationWithMembership
} from './helpers/organization-seed'

const authHarness = readAuthHarnessConfig()
const mailpitHarness = readMailpitHarnessConfig()
const serverUrl = process.env.NEVIX_TEST_SERVER_URL

const HOME_HEADING = 'Create with Nevix AI'
const PICKER_HEADING = 'Select an organization'

async function signIn(
  page: Page,
  identity: { readonly email: string; readonly password: string }
): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible()
  await page.getByLabel('Email').fill(identity.email)
  await page.getByLabel('Password', { exact: true }).fill(identity.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

async function signUpAndVerifyInvitationEmail(
  page: Page,
  identity: { readonly email: string; readonly password: string },
  excludedMessageIds: readonly string[]
): Promise<void> {
  if (!mailpitHarness) throw new Error('Mailpit URL is unavailable')

  await expect(page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible()
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Email').fill(identity.email)
  await page.getByLabel('Password', { exact: true }).fill(identity.password)
  await page.getByLabel('Confirm password').fill(identity.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()

  const registrationMessage = await waitForRegistrationMessage(
    mailpitHarness,
    excludedMessageIds,
    identity.email
  )
  await page.getByRole('textbox', { name: 'Verification code' }).fill(registrationMessage.code)
  await page.getByRole('button', { name: 'Verify email' }).click()
}

async function postInvitationCommand(
  path: string,
  accessToken: string,
  body: Record<string, string>
): Promise<Response> {
  if (!serverUrl) throw new Error('Identity server URL is unavailable')

  return fetch(new URL(path, serverUrl), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
}

async function createInvitation(
  organizationId: string,
  accessToken: string,
  email: string
): Promise<string> {
  const response = await postInvitationCommand(
    `/identity/organizations/${organizationId}/invitations`,
    accessToken,
    { email }
  )
  if (!response.ok) throw new Error(`Unable to create test invitation: ${response.status}`)

  const body: unknown = await response.json()
  const invitation = (body as { invitation?: { id?: unknown } }).invitation
  if (typeof invitation?.id !== 'string') throw new Error('Invitation command returned no id')
  return invitation.id
}

async function resendInvitation(
  organizationId: string,
  invitationId: string,
  accessToken: string
): Promise<void> {
  const response = await postInvitationCommand(
    `/identity/organizations/${organizationId}/invitations/${invitationId}/resend`,
    accessToken,
    {}
  )
  if (!response.ok) throw new Error(`Unable to resend test invitation: ${response.status}`)
}

async function revokeInvitation(
  organizationId: string,
  invitationId: string,
  accessToken: string
): Promise<void> {
  const response = await postInvitationCommand(
    `/identity/organizations/${organizationId}/invitations/${invitationId}/revoke`,
    accessToken,
    {}
  )
  if (!response.ok) throw new Error(`Unable to revoke test invitation: ${response.status}`)
}

async function readRememberedOrganizationId(userDataDir: string): Promise<string> {
  const contents = await readFile(join(userDataDir, 'active-organization.json'), 'utf8')
  const value: unknown = JSON.parse(contents)
  const organizationId = (value as { organizationId?: unknown }).organizationId
  if (typeof organizationId !== 'string' || organizationId.length === 0) {
    throw new Error('The accepted Organization was not persisted as active')
  }
  return organizationId
}

test(
  'a verified invitee without a Profile must finish it after restarting on another device',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(150_000)
    test.skip(
      !authHarness || !mailpitHarness || !serverUrl,
      'requires the Desktop invitation acceptance integration harness'
    )
    if (!authHarness || !mailpitHarness || !serverUrl) return

    const owner = uniqueAuthIdentity('invitation-restart-owner')
    const invitee = uniqueAuthIdentity('invitation-restart-invitee')
    const ownerId = await createAuthUser(authHarness, owner, true)
    const inviteeId = await createAuthUser(authHarness, invitee, true)
    const organization = await seedOrganizationWithMembership(ownerId, {
      name: 'Restarted Invite Studio'
    })
    const ownerSession = await signInOutsideDesktop(authHarness, owner)
    const messagesBeforeInvitation = await readMailpitMessageIds(mailpitHarness)
    const invitationId = await createInvitation(
      organization.id,
      ownerSession.access_token,
      invitee.email
    )
    const invitationMessage = await waitForRegistrationMessage(
      mailpitHarness,
      messagesBeforeInvitation,
      invitee.email
    )
    const firstDeviceUserDataDir = await mkdtemp(join(tmpdir(), 'nevix-invitation-first-device-'))
    const secondDeviceUserDataDir = await mkdtemp(join(tmpdir(), 'nevix-invitation-second-device-'))

    try {
      const firstLaunch = await launchTestApp({
        userDataDir: firstDeviceUserDataDir,
        systemLanguages: ['en-US']
      })
      try {
        await signIn(firstLaunch.page, invitee)
        await expect(
          firstLaunch.page.getByRole('heading', { name: 'What should we call you?' })
        ).toBeVisible()
        await expect(firstLaunch.page.getByRole('heading', { name: PICKER_HEADING })).toHaveCount(0)
        await expect(firstLaunch.page.getByRole('heading', { name: HOME_HEADING })).toHaveCount(0)
      } finally {
        await firstLaunch.electronApp.close()
      }

      await expect
        .poll(() => readInvitationAcceptanceState(inviteeId, invitationId))
        .toEqual({
          displayName: undefined,
          invitationStatus: 'pending',
          organizations: []
        })

      const secondLaunch = await launchTestApp({
        userDataDir: secondDeviceUserDataDir,
        systemLanguages: ['en-US']
      })
      try {
        await signIn(secondLaunch.page, invitee)
        await expect(
          secondLaunch.page.getByRole('heading', { name: 'What should we call you?' })
        ).toBeVisible()
        await secondLaunch.page.getByLabel('Display name').fill('  Restarted Invitee  ')
        const profileResponse = secondLaunch.page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' && response.url().includes('/rest/v1/profiles')
        )
        await secondLaunch.page.getByRole('button', { name: 'Continue' }).click()
        expect((await profileResponse).status()).toBe(201)

        await expect(secondLaunch.page.getByRole('heading', { name: PICKER_HEADING })).toBeVisible()
        await expect(
          secondLaunch.page.getByRole('heading', { name: 'Create your first organization' })
        ).toHaveCount(0)
        await secondLaunch.page.getByRole('button', { name: 'Accept' }).click()
        await secondLaunch.page
          .getByRole('textbox', { name: 'Invitation code' })
          .fill(invitationMessage.code)
        await secondLaunch.page.getByRole('button', { name: 'Verify and join' }).click()
        await expect(secondLaunch.page.getByRole('heading', { name: HOME_HEADING })).toBeVisible()
        await expect
          .poll(() => readRememberedOrganizationId(secondDeviceUserDataDir))
          .toBe(organization.id)
      } finally {
        await secondLaunch.electronApp.close()
      }

      await expect
        .poll(() => readInvitationAcceptanceState(inviteeId, invitationId))
        .toEqual({
          displayName: 'Restarted Invitee',
          invitationStatus: 'accepted',
          organizations: [
            {
              id: organization.id,
              name: 'Restarted Invite Studio',
              role: 'member',
              status: 'active'
            }
          ]
        })
    } finally {
      await rm(firstDeviceUserDataDir, { recursive: true, force: true })
      await rm(secondDeviceUserDataDir, { recursive: true, force: true })
    }
  }
)

test(
  'a fresh invited User saves their Profile and joins only the invited Organization with a resent code',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(150_000)
    test.skip(
      !authHarness || !mailpitHarness || !serverUrl,
      'requires the Desktop invitation acceptance integration harness'
    )
    if (!authHarness || !mailpitHarness || !serverUrl) return

    const owner = uniqueAuthIdentity('invitation-accept-owner')
    const invitee = uniqueAuthIdentity('invitation-accept-invitee')
    const ownerId = await createAuthUser(authHarness, owner, true)
    const organization = await seedOrganizationWithMembership(ownerId, {
      name: 'Invited Studio',
      profileDisplayName: 'Invitation Owner'
    })
    const ownerSession = await signInOutsideDesktop(authHarness, owner)

    const messagesBeforeInvitation = await readMailpitMessageIds(mailpitHarness)
    const invitationId = await createInvitation(
      organization.id,
      ownerSession.access_token,
      invitee.email
    )
    const firstMessage = await waitForRegistrationMessage(
      mailpitHarness,
      messagesBeforeInvitation,
      invitee.email
    )
    const ownerUserDataDir = await mkdtemp(join(tmpdir(), 'nevix-invitation-owner-'))
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-invitation-acceptance-'))

    try {
      const ownerLaunched = await launchTestApp({
        userDataDir: ownerUserDataDir,
        systemLanguages: ['en-US']
      })
      try {
        await signIn(ownerLaunched.page, owner)
        await expect(ownerLaunched.page.getByRole('heading', { name: HOME_HEADING })).toBeVisible()
        await expect(ownerLaunched.page.getByRole('heading', { name: PICKER_HEADING })).toHaveCount(
          0
        )
      } finally {
        await ownerLaunched.electronApp.close()
      }

      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        const messagesBeforeSignup = await readMailpitMessageIds(mailpitHarness)
        await signUpAndVerifyInvitationEmail(launched.page, invitee, messagesBeforeSignup)

        await expect(
          launched.page.getByRole('heading', { name: 'What should we call you?' })
        ).toBeVisible()
        await launched.page.getByLabel('Display name').fill('  Avery Invitee  ')
        const profileResponse = launched.page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' && response.url().includes('/rest/v1/profiles')
        )
        await launched.page.getByRole('button', { name: 'Continue' }).click()
        expect((await profileResponse).status()).toBe(201)

        await expect(launched.page.getByRole('heading', { name: PICKER_HEADING })).toBeVisible()
        await expect(
          launched.page.getByRole('heading', { name: 'Create your first organization' })
        ).toHaveCount(0)
        await expect(launched.page.getByText('Pending invitations')).toBeVisible()
        await expect(
          launched.page.getByText('Invitation Owner invited you to join "Invited Studio"')
        ).toBeVisible()
        await expect(launched.page.getByRole('heading', { name: HOME_HEADING })).toHaveCount(0)

        await launched.page.getByRole('button', { name: 'Accept' }).click()
        const codeInput = launched.page.getByRole('textbox', { name: 'Invitation code' })
        await expect(codeInput).toBeVisible()

        const wrongCode = firstMessage.code === '000000' ? '999999' : '000000'
        for (const remaining of [4, 3, 2, 1, 0]) {
          await codeInput.fill(wrongCode)
          await launched.page.getByRole('button', { name: 'Verify and join' }).click()
          await expect(
            launched.page
              .getByRole('alert')
              .filter({ hasText: `Incorrect code, ${remaining} attempts left` })
          ).toBeVisible()
        }

        await ageInvitationCodeBeyondCooldown(invitationId)
        const messagesBeforeResend = await readMailpitMessageIds(mailpitHarness)
        await resendInvitation(organization.id, invitationId, ownerSession.access_token)
        const resentMessage = await waitForRegistrationMessage(
          mailpitHarness,
          messagesBeforeResend,
          invitee.email
        )

        await codeInput.fill(firstMessage.code)
        await launched.page.getByRole('button', { name: 'Verify and join' }).click()
        await expect(
          launched.page
            .getByRole('alert')
            .filter({ hasText: 'This invitation code is no longer valid. Request a resend.' })
        ).toBeVisible()

        await codeInput.fill(resentMessage.code)
        await launched.page.getByRole('button', { name: 'Verify and join' }).click()
        await expect(launched.page.getByRole('heading', { name: HOME_HEADING })).toBeVisible()
        await expect.poll(() => readRememberedOrganizationId(userDataDir)).toBe(organization.id)

        const inviteeSession = await signInOutsideDesktop(authHarness, invitee)
        await expect
          .poll(() => readInvitationAcceptanceState(inviteeSession.user.id, invitationId))
          .toEqual({
            displayName: 'Avery Invitee',
            invitationStatus: 'accepted',
            organizations: [
              {
                id: organization.id,
                name: 'Invited Studio',
                role: 'member',
                status: 'active'
              }
            ]
          })
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(ownerUserDataDir, { recursive: true, force: true })
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)

test(
  'expired guidance remains clear and a revoked invitation disappears after its open sheet closes',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(150_000)
    test.skip(
      !authHarness || !mailpitHarness || !serverUrl,
      'requires the Desktop invitation acceptance integration harness'
    )
    if (!authHarness || !mailpitHarness || !serverUrl) return

    const owner = uniqueAuthIdentity('invitation-expired-owner')
    const invitee = uniqueAuthIdentity('invitation-expired-invitee')
    const ownerId = await createAuthUser(authHarness, owner, true)
    const inviteeId = await createAuthUser(authHarness, invitee, true)
    await seedProfile(inviteeId, 'Expired Invitee')
    const organization = await seedOrganizationWithMembership(ownerId, {
      name: 'Expired Studio',
      profileDisplayName: 'Expired Owner'
    })
    const ownerSession = await signInOutsideDesktop(authHarness, owner)

    const messagesBeforeInvitation = await readMailpitMessageIds(mailpitHarness)
    const invitationId = await createInvitation(
      organization.id,
      ownerSession.access_token,
      invitee.email
    )
    const invitationMessage = await waitForRegistrationMessage(
      mailpitHarness,
      messagesBeforeInvitation,
      invitee.email
    )
    await expireInvitation(invitationId)
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-invitation-expired-'))

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await signIn(launched.page, invitee)
        await expect(launched.page.getByRole('heading', { name: PICKER_HEADING })).toBeVisible()
        await launched.page.getByRole('button', { name: 'Accept' }).click()
        await launched.page
          .getByRole('textbox', { name: 'Invitation code' })
          .fill(invitationMessage.code)
        await launched.page.getByRole('button', { name: 'Verify and join' }).click()
        await expect(
          launched.page
            .getByRole('alert')
            .filter({ hasText: 'This invitation has expired. Request a resend.' })
        ).toBeVisible()
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }

    const revokedInvitee = uniqueAuthIdentity('invitation-revoked-invitee')
    const revokedInviteeId = await createAuthUser(authHarness, revokedInvitee, true)
    await seedProfile(revokedInviteeId, 'Revoked Invitee')
    const messagesBeforeRevocation = await readMailpitMessageIds(mailpitHarness)
    const revokedInvitationId = await createInvitation(
      organization.id,
      ownerSession.access_token,
      revokedInvitee.email
    )
    const revokedInvitationMessage = await waitForRegistrationMessage(
      mailpitHarness,
      messagesBeforeRevocation,
      revokedInvitee.email
    )
    const revokedUserDataDir = await mkdtemp(join(tmpdir(), 'nevix-invitation-revoked-'))

    try {
      const launched = await launchTestApp({
        userDataDir: revokedUserDataDir,
        systemLanguages: ['en-US']
      })
      try {
        await signIn(launched.page, revokedInvitee)
        await expect(launched.page.getByRole('heading', { name: PICKER_HEADING })).toBeVisible()
        const revokedInvitationLine = launched.page.getByText(
          'Expired Owner invited you to join "Expired Studio"'
        )
        await expect(revokedInvitationLine).toBeVisible()
        await launched.page.getByRole('button', { name: 'Accept' }).click()
        await expect(launched.page.getByRole('textbox', { name: 'Invitation code' })).toBeVisible()

        // The row is RLS-hidden once revoked, so revoke only after its pre-existing sheet opens.
        await revokeInvitation(organization.id, revokedInvitationId, ownerSession.access_token)
        await launched.page
          .getByRole('textbox', { name: 'Invitation code' })
          .fill(revokedInvitationMessage.code)
        await launched.page.getByRole('button', { name: 'Verify and join' }).click()
        await expect(
          launched.page
            .getByRole('alert')
            .filter({ hasText: 'This invitation has been revoked. Request a new invitation.' })
        ).toBeVisible()

        await launched.page.getByRole('button', { name: 'Cancel' }).click()
        await expect(revokedInvitationLine).toHaveCount(0)
        await expect(launched.page.getByText('Pending invitations')).toHaveCount(0)
        await expect(
          launched.page.getByRole('heading', { name: 'Create your first organization' })
        ).toBeVisible()
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(revokedUserDataDir, { recursive: true, force: true })
    }
  }
)
