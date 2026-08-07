import { expect, test } from '@playwright/test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'
import {
  createAuthUser,
  deleteAuthUser,
  readAuthHarnessConfig,
  refreshOutsideDesktop,
  signInOutsideDesktop,
  uniqueAuthIdentity
} from './helpers/supabase-auth'
import {
  readMailpitHarnessConfig,
  readMailpitMessageIds,
  waitForNotificationMessage,
  waitForRegistrationMessage
} from './helpers/mailpit'
import { seedOrganizationWithMembership } from '../organization/helpers/organization-seed'

const authHarness = readAuthHarnessConfig()
const mailpitHarness = readMailpitHarnessConfig()

const SESSION_FILE_NAME = 'authentication-session.enc'

test('the full recovery loop rotates the password, revokes old Sessions, and never persists the recovery Session', async () => {
  test.setTimeout(90_000)
  test.skip(!authHarness || !mailpitHarness, 'requires disposable Supabase Auth and Mailpit')
  if (!authHarness || !mailpitHarness) return

  const identity = uniqueAuthIdentity('recovery')
  // Leading/trailing spaces and multi-byte characters prove the original-bytes contract end to end.
  const newPassword = '  新密码Rotated42  '
  const userId = await createAuthUser(authHarness, identity, true)
  // The final sign-in with the rotated password must reach the App Shell, which requires an
  // Organization to auto-enter.
  await seedOrganizationWithMembership(userId, { name: 'Recovery Org' })
  const oldSession = await signInOutsideDesktop(authHarness, identity)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-recovery-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)

  try {
    let launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

    try {
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await launched.page.getByRole('button', { name: 'Forgot password?' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Reset your password' })
      ).toBeVisible()

      const messagesBeforeRequest = await readMailpitMessageIds(mailpitHarness)
      await launched.page.getByLabel('Email').fill(identity.email)
      await launched.page.getByRole('button', { name: 'Send recovery code' }).click()

      await expect(
        launched.page.getByRole('heading', { name: 'Enter your recovery code' })
      ).toBeVisible()
      await expect(
        launched.page.getByText('If this email is registered, we sent a six-digit recovery code.')
      ).toBeVisible()

      const recoveryMessage = await waitForRegistrationMessage(
        mailpitHarness,
        messagesBeforeRequest,
        identity.email
      )
      expect(recoveryMessage.body).toContain('验证码有效期为一小时')
      expect(recoveryMessage.body).toContain('valid for one hour')
      expect(recoveryMessage.body).not.toContain('http://')
      expect(recoveryMessage.body).not.toContain('https://')

      const codeInput = launched.page.getByLabel('Recovery code')
      await codeInput.fill(recoveryMessage.code.slice(0, 5))
      await expect(launched.page.getByRole('button', { name: 'Verify code' })).toBeDisabled()

      const incorrectCode = recoveryMessage.code === '000000' ? '111111' : '000000'
      await codeInput.fill(incorrectCode)
      await launched.page.getByRole('button', { name: 'Verify code' }).click()
      await expect(
        launched.page.getByRole('alert').filter({
          hasText: 'Recovery code is invalid or expired'
        })
      ).toBeVisible()

      await codeInput.fill(recoveryMessage.code)
      await launched.page.getByRole('button', { name: 'Verify code' }).click()
      await expect(launched.page.getByRole('heading', { name: 'Set a new password' })).toBeVisible()

      // Restarting the subflow issues a fresh code; the consumed one must be rejected as used.
      await launched.page.getByRole('button', { name: 'Back to sign in' }).click()
      await launched.page.getByRole('button', { name: 'Forgot password?' }).click()
      const messagesBeforeSecondRequest = await readMailpitMessageIds(mailpitHarness)
      await launched.page.getByLabel('Email').fill(identity.email)
      // GoTrue's root-stack mailer cadence uses wall time, unlike the auth-only harness.
      await launched.page.waitForTimeout(1_100)
      await launched.page.getByRole('button', { name: 'Send recovery code' }).click()
      const secondRecoveryMessage = await waitForRegistrationMessage(
        mailpitHarness,
        messagesBeforeSecondRequest,
        identity.email
      )
      await codeInput.fill(recoveryMessage.code)
      await launched.page.getByRole('button', { name: 'Verify code' }).click()
      await expect(
        launched.page.getByRole('alert').filter({
          hasText: 'Recovery code is invalid or expired'
        })
      ).toBeVisible()

      await codeInput.fill(secondRecoveryMessage.code)
      await launched.page.getByRole('button', { name: 'Verify code' }).click()
      await expect(launched.page.getByRole('heading', { name: 'Set a new password' })).toBeVisible()

      const passwordInput = launched.page.getByLabel('New password')
      await passwordInput.fill('12345678901')
      await expect(launched.page.getByText('11 of 12–72 UTF-8 bytes')).toBeVisible()
      await expect(launched.page.getByRole('button', { name: 'Update password' })).toBeDisabled()
      await passwordInput.fill('x'.repeat(73))
      await expect(launched.page.getByText('73 of 12–72 UTF-8 bytes')).toBeVisible()
      await expect(launched.page.getByRole('button', { name: 'Update password' })).toBeDisabled()

      await passwordInput.fill(identity.password)
      await launched.page.getByRole('button', { name: 'Update password' }).click()
      await expect(
        launched.page.getByRole('alert').filter({
          hasText: 'New password must be different from your old password'
        })
      ).toBeVisible()

      const messagesBeforeUpdate = await readMailpitMessageIds(mailpitHarness)
      await passwordInput.fill(newPassword)
      await expect(launched.page.getByText('22 of 12–72 UTF-8 bytes')).toBeVisible()
      const updateResponsePromise = launched.page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' && response.url().includes('/auth/v1/user')
      )
      await launched.page.getByRole('button', { name: 'Update password' }).click()
      const updateResponse = await updateResponsePromise
      expect({
        status: updateResponse.status(),
        submittedOriginalPassword: updateResponse.request().postData()?.includes(newPassword)
      }).toEqual({ status: 200, submittedOriginalPassword: true })

      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expect(
        launched.page.getByRole('status').filter({
          hasText: 'Your password was updated. Sign in with your new password.'
        })
      ).toBeVisible()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toHaveCount(0)
      await expect(stat(sessionPath)).rejects.toThrow()

      const notification = await waitForNotificationMessage(mailpitHarness, messagesBeforeUpdate)
      expect(notification.body).toContain('密码刚刚被修改')
      expect(notification.body).toContain('was just changed')
      expect(notification.body).not.toContain('http://')
      expect(notification.body).not.toContain('https://')
      expect(notification.body).not.toMatch(/\b\d{6}\b/)

      await expect(refreshOutsideDesktop(authHarness, oldSession.refresh_token)).rejects.toThrow()
    } finally {
      await launched.electronApp.close()
    }

    // A fresh launch proves nothing about the recovery subflow was persisted across restarts.
    await expect(stat(sessionPath)).rejects.toThrow()
    launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()

      await launched.page.getByLabel('Email').fill(identity.email)
      await launched.page.getByLabel('Password').fill(newPassword)
      await launched.page.getByRole('button', { name: 'Sign in' }).click()
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

test('recovery entry points stay existence-neutral and failures map to safe localized messages', async () => {
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const signupIdentity = uniqueAuthIdentity('recovery-neutral-signup')
  const unknownEmail = `recovery-unknown-${Date.now()}-${crypto.randomUUID()}@nevix.test`
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-recovery-neutral-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

    try {
      await launched.page.getByRole('button', { name: 'Forgot password?' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Reset your password' })
      ).toBeVisible()
      await launched.page.getByRole('button', { name: 'Back to sign in' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()

      await launched.page.getByRole('button', { name: 'Create account' }).click()
      await launched.page.getByLabel('Email').fill(signupIdentity.email)
      await launched.page.getByLabel('Password', { exact: true }).fill(signupIdentity.password)
      await launched.page.getByLabel('Confirm password').fill(signupIdentity.password)
      await launched.page.getByRole('button', { name: 'Create account' }).click()
      await expect(launched.page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
      await launched.page.getByRole('button', { name: 'Forgot password?' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Reset your password' })
      ).toBeVisible()

      await launched.page.getByLabel('Email').fill(unknownEmail)
      await launched.page.route('**/auth/v1/recover**', (route) => route.abort('failed'))
      await launched.page.getByRole('button', { name: 'Send recovery code' }).click()
      await expect(
        launched.page.getByRole('alert').filter({
          hasText: 'The recovery code cannot be sent right now. Try again later.'
        })
      ).toBeVisible()
      await launched.page.unroute('**/auth/v1/recover**')

      await launched.page.route('**/auth/v1/recover**', (route) =>
        route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'over_email_send_rate_limit',
            message: 'provider detail must not reach the user'
          })
        })
      )
      await launched.page.getByRole('button', { name: 'Send recovery code' }).click()
      await expect(
        launched.page.getByRole('alert').filter({
          hasText: 'Too many requests. Try again later.'
        })
      ).toBeVisible()
      await expect(launched.page.getByText('provider detail must not reach the user')).toHaveCount(
        0
      )
      await launched.page.unroute('**/auth/v1/recover**')

      // An unregistered email reaches the exact same neutral code state as a registered one.
      const recoverResponsePromise = launched.page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' && response.url().includes('/auth/v1/recover')
      )
      await launched.page.getByRole('button', { name: 'Send recovery code' }).click()
      expect((await recoverResponsePromise).status()).toBe(200)
      await expect(
        launched.page.getByRole('heading', { name: 'Enter your recovery code' })
      ).toBeVisible()
      await expect(
        launched.page.getByText('If this email is registered, we sent a six-digit recovery code.')
      ).toBeVisible()

      // The verification step maps 429, network failure, and expired codes without provider text.
      await launched.page.getByLabel('Recovery code').fill('123456')
      await launched.page.route('**/auth/v1/verify**', (route) =>
        route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'over_email_send_rate_limit',
            message: 'provider detail must not reach the user'
          })
        })
      )
      await launched.page.getByRole('button', { name: 'Verify code' }).click()
      await expect(
        launched.page.getByRole('alert').filter({
          hasText: 'Too many requests. Try again later.'
        })
      ).toBeVisible()
      await launched.page.unroute('**/auth/v1/verify**')

      await launched.page.route('**/auth/v1/verify**', (route) => route.abort('failed'))
      await launched.page.getByRole('button', { name: 'Verify code' }).click()
      await expect(
        launched.page.getByRole('alert').filter({
          hasText: 'Verification is temporarily unavailable. Try again later.'
        })
      ).toBeVisible()
      await launched.page.unroute('**/auth/v1/verify**')

      await launched.page.route('**/auth/v1/verify**', (route) =>
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            error_code: 'otp_expired',
            msg: 'provider detail must not reach the user'
          })
        })
      )
      await launched.page.getByRole('button', { name: 'Verify code' }).click()
      await expect(
        launched.page.getByRole('alert').filter({
          hasText: 'Recovery code is invalid or expired'
        })
      ).toBeVisible()
      await expect(
        launched.page.getByRole('heading', { name: 'Enter your recovery code' })
      ).toBeVisible()
      await expect(launched.page.getByText('provider detail must not reach the user')).toHaveCount(
        0
      )
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('a failed global revocation still discards the recovery Session and reports the delay', async () => {
  test.setTimeout(60_000)
  test.skip(!authHarness || !mailpitHarness, 'requires disposable Supabase Auth and Mailpit')
  if (!authHarness || !mailpitHarness) return

  const identity = uniqueAuthIdentity('recovery-revocation')
  const userId = await createAuthUser(authHarness, identity, true)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-recovery-revocation-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

    try {
      await launched.page.getByRole('button', { name: 'Forgot password?' }).click()
      const messagesBeforeRequest = await readMailpitMessageIds(mailpitHarness)
      await launched.page.getByLabel('Email').fill(identity.email)
      await launched.page.getByRole('button', { name: 'Send recovery code' }).click()

      const recoveryMessage = await waitForRegistrationMessage(
        mailpitHarness,
        messagesBeforeRequest,
        identity.email
      )
      await launched.page.getByLabel('Recovery code').fill(recoveryMessage.code)
      await launched.page.getByRole('button', { name: 'Verify code' }).click()
      await expect(launched.page.getByRole('heading', { name: 'Set a new password' })).toBeVisible()

      // The update step maps 429 and network failure safely and stays in the recovery flow.
      await launched.page.getByLabel('New password').fill(`Rotated password ${Date.now()}`)
      await launched.page.route('**/auth/v1/user**', (route) =>
        route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'over_request_rate_limit',
            message: 'provider detail must not reach the user'
          })
        })
      )
      await launched.page.getByRole('button', { name: 'Update password' }).click()
      await expect(
        launched.page.getByRole('alert').filter({
          hasText: 'Too many requests. Try again later.'
        })
      ).toBeVisible()
      await launched.page.unroute('**/auth/v1/user**')

      await launched.page.route('**/auth/v1/user**', (route) => route.abort('failed'))
      await launched.page.getByRole('button', { name: 'Update password' }).click()
      await expect(
        launched.page.getByRole('alert').filter({
          hasText: 'The password cannot be updated right now. Try again later.'
        })
      ).toBeVisible()
      await expect(launched.page.getByRole('heading', { name: 'Set a new password' })).toBeVisible()
      await expect(launched.page.getByText('provider detail must not reach the user')).toHaveCount(
        0
      )
      await launched.page.unroute('**/auth/v1/user**')

      await launched.page.route('**/auth/v1/logout**', (route) => route.abort('failed'))
      await launched.page.getByRole('button', { name: 'Update password' }).click()

      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expect(
        launched.page.getByRole('status').filter({
          hasText:
            'Your password was updated, but signing out other devices may be delayed. Sign in with your new password.'
        })
      ).toBeVisible()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toHaveCount(0)
      await expect(stat(sessionPath)).rejects.toThrow()
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, userId)
  }
})
