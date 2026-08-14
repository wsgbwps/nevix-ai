import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'
import {
  createAuthUser,
  deleteAuthUser,
  readAuthHarnessConfig,
  uniqueAuthIdentity
} from './helpers/supabase-auth'
import {
  readMailpitHarnessConfig,
  readMailpitMessageIds,
  waitForRegistrationMessage
} from './helpers/mailpit'

const authHarness = readAuthHarnessConfig()
const mailpitHarness = readMailpitHarnessConfig()
const SIGNUP_BOUNDARY_REMEMBERED_EMAIL = 'signup-boundary@example.com'

test(
  'a new User signs up with the original password and verifies a resent six-digit code',
  { tag: '@smoke' },
  async () => {
    test.skip(!authHarness || !mailpitHarness, 'requires disposable Supabase Auth and Mailpit')
    if (!authHarness || !mailpitHarness) return

    const identity = uniqueAuthIdentity('signup')
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-signup-'))

    try {
      const launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['en-US']
      })

      try {
        await expect(
          launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
        ).toBeVisible()
        await launched.page.evaluate(
          async (email) => window.api.invoke('authentication:replace-remembered-email', { email }),
          SIGNUP_BOUNDARY_REMEMBERED_EMAIL
        )
        await launched.page.getByRole('button', { name: 'Create account' }).click()
        await expect(
          launched.page.getByRole('heading', { name: 'Create your Nevix AI account' })
        ).toBeVisible()

        const password = '  密码Secret42  '
        await launched.page.getByLabel('Email').fill(identity.email)
        await expect(
          launched.page.getByText('We recommend using 12 or more characters.')
        ).toHaveCount(0)
        await launched.page.getByLabel('Password', { exact: true }).fill('12345678901')
        await expect(
          launched.page.getByRole('alert').filter({
            hasText: 'We recommend using 12 or more characters. Password is too short'
          })
        ).toBeVisible()
        await expect(launched.page.getByRole('button', { name: 'Create account' })).toBeDisabled()
        await launched.page.getByLabel('Password', { exact: true }).fill('x'.repeat(73))
        await expect(
          launched.page.getByRole('alert').filter({ hasText: 'Password is too long' })
        ).toBeVisible()
        await expect(launched.page.getByRole('button', { name: 'Create account' })).toBeDisabled()

        await launched.page.getByLabel('Password', { exact: true }).fill(password)
        await expect(launched.page.getByText(/UTF-8 bytes/)).toHaveCount(0)
        await expect(
          launched.page.getByRole('alert').filter({ hasText: /Password is too/ })
        ).toHaveCount(0)
        await launched.page.getByLabel('Confirm password').fill('a mismatched confirmation')
        await expect(launched.page.getByText('Passwords do not match')).toBeVisible()
        await expect(launched.page.getByRole('button', { name: 'Create account' })).toBeDisabled()
        await launched.page.getByLabel('Confirm password').fill(password)
        await expect(launched.page.getByText('Passwords do not match')).toHaveCount(0)
        const messagesBeforeSignup = await readMailpitMessageIds(mailpitHarness)
        const signupResponsePromise = launched.page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' && response.url().includes('/auth/v1/signup')
        )
        await launched.page.getByRole('button', { name: 'Create account' }).click()
        const signupResponse = await signupResponsePromise
        const signupPayload = signupResponse.request().postData()
        expect({
          status: signupResponse.status(),
          submittedEmail: signupPayload?.includes(identity.email),
          submittedOriginalPassword: signupPayload?.includes(password),
          submittedNoConfirmField: signupPayload
            ? !signupPayload.includes('confirmPassword')
            : false
        }).toEqual({
          status: 200,
          submittedEmail: true,
          submittedOriginalPassword: true,
          submittedNoConfirmField: true
        })
        await expect
          .poll(async () => (await readMailpitMessageIds(mailpitHarness)).length)
          .toBeGreaterThan(messagesBeforeSignup.length)

        await expect(launched.page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
        await expect(
          launched.page.getByText(
            'If this email can be used to sign up, we sent a six-digit verification code.'
          )
        ).toBeVisible()

        const firstMessage = await waitForRegistrationMessage(
          mailpitHarness,
          messagesBeforeSignup,
          identity.email
        )
        expect(firstMessage.body).toContain('验证码有效期为一小时')
        expect(firstMessage.body).toContain('valid for one hour')
        expect(firstMessage.body).not.toContain('http://')
        expect(firstMessage.body).not.toContain('https://')

        const codeInput = launched.page.getByLabel('Verification code')
        await codeInput.fill(firstMessage.code.slice(0, 5))
        await expect(launched.page.getByRole('button', { name: 'Verify email' })).toBeDisabled()

        const incorrectCode = firstMessage.code === '000000' ? '111111' : '000000'
        await codeInput.fill(incorrectCode)
        await launched.page.getByRole('button', { name: 'Verify email' }).click()
        await expect(
          launched.page.getByRole('alert').filter({
            hasText: 'Verification code is invalid or expired'
          })
        ).toBeVisible()
        await expect(codeInput).toHaveValue(incorrectCode)

        const resendButton = launched.page.getByRole('button', { name: /Resend in \d+s/ })
        await expect(resendButton).toBeDisabled()
        await launched.page.clock.install()
        await launched.page.clock.fastForward(60_000)
        await expect(launched.page.getByRole('button', { name: 'Resend code' })).toBeEnabled()
        await launched.page.clock.resume()
        // The test clock drives the client cooldown; GoTrue still enforces its configured
        // one-second SMTP cadence against wall time in the root Supabase integration stack.
        await launched.page.waitForTimeout(1_100)
        await launched.page.getByRole('button', { name: 'Resend code' }).click()
        await expect(
          launched.page.getByText('A new code was sent. Your previous code is no longer valid.')
        ).toBeVisible()

        const secondMessage = await waitForRegistrationMessage(
          mailpitHarness,
          [...messagesBeforeSignup, firstMessage.id],
          identity.email
        )

        await codeInput.fill(firstMessage.code)
        await launched.page.getByRole('button', { name: 'Verify email' }).click()
        await expect(
          launched.page.getByRole('alert').filter({
            hasText: 'Verification code is invalid or expired'
          })
        ).toBeVisible()

        await codeInput.fill(secondMessage.code)
        await launched.page.getByRole('button', { name: 'Verify email' }).click()
        await expect(
          launched.page.getByRole('heading', { name: 'What should we call you?' })
        ).toBeVisible()
        expect(
          await launched.page.evaluate(() =>
            window.api.invoke('authentication:read-remembered-email')
          )
        ).toMatchObject({
          outcome: 'email',
          email: SIGNUP_BOUNDARY_REMEMBERED_EMAIL
        })
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)

test('verified and unverified repeat registrations share the neutral visible outcome', async () => {
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identities = [
    { identity: uniqueAuthIdentity('repeat-verified'), emailConfirmed: true },
    { identity: uniqueAuthIdentity('repeat-unverified'), emailConfirmed: false }
  ]
  const userIds = await Promise.all(
    identities.map(({ identity, emailConfirmed }) =>
      createAuthUser(authHarness, identity, emailConfirmed)
    )
  )
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-repeat-signup-'))

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US']
    })

    try {
      for (const { identity } of identities) {
        await launched.page.getByRole('button', { name: 'Create account' }).click()
        await launched.page.getByLabel('Email').fill(identity.email)
        await launched.page.getByLabel('Password', { exact: true }).fill(identity.password)
        await launched.page.getByLabel('Confirm password').fill(identity.password)
        await launched.page.getByRole('button', { name: 'Create account' }).click()

        await expect(launched.page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
        await expect(
          launched.page.getByText(
            'If this email can be used to sign up, we sent a six-digit verification code.'
          )
        ).toBeVisible()
        await expect(launched.page.getByRole('button', { name: 'Go to sign in' })).toBeVisible()
        await launched.page.getByRole('button', { name: 'Go to sign in' }).click()
      }
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await Promise.all(userIds.map((userId) => deleteAuthUser(authHarness, userId)))
  }
})

test('signup network and rate-limit failures stay localized and existence-neutral', async () => {
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('signup-safe-errors')
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-signup-errors-'))

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US']
    })

    try {
      await launched.page.getByRole('button', { name: 'Create account' }).click()
      await launched.page.getByLabel('Email').fill(identity.email)
      await launched.page.getByLabel('Password', { exact: true }).fill(identity.password)
      await launched.page.getByLabel('Confirm password').fill(identity.password)

      await launched.page.route('**/auth/v1/signup', (route) =>
        route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'weak_password',
            message: 'provider detail must not reach the user',
            weak_password: { reasons: ['pwned'] }
          })
        })
      )
      await launched.page.getByRole('button', { name: 'Create account' }).click()
      await expect(
        launched.page.getByRole('alert').filter({
          hasText: 'This password has appeared in a data breach. Choose a different password.'
        })
      ).toBeVisible()
      await expect(launched.page.getByText('provider detail must not reach the user')).toHaveCount(
        0
      )
      await launched.page.unroute('**/auth/v1/signup')

      const providerWarnings: string[] = []
      launched.page.on('console', (message) => {
        if (message.type() === 'warning') providerWarnings.push(message.text())
      })
      await launched.page.route('**/auth/v1/signup', (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'future_auth_failure',
            message: 'provider detail must not reach the user'
          })
        })
      )
      await launched.page.getByRole('button', { name: 'Create account' }).click()
      await expect(
        launched.page.getByRole('alert').filter({
          hasText: 'Sign-up is temporarily unavailable. Try again later.'
        })
      ).toBeVisible()
      await expect
        .poll(() => providerWarnings)
        .toContain(
          '[authentication] Unmapped password provider error operation=signup code=future_auth_failure status=503'
        )
      await expect(launched.page.getByText('provider detail must not reach the user')).toHaveCount(
        0
      )
      await launched.page.unroute('**/auth/v1/signup')

      await launched.page.route('**/auth/v1/signup', (route) => route.abort('failed'))
      await launched.page.getByRole('button', { name: 'Create account' }).click()
      await expect(
        launched.page.getByRole('alert').filter({
          hasText: 'Sign-up is temporarily unavailable. Try again later.'
        })
      ).toBeVisible()
      await launched.page.unroute('**/auth/v1/signup')

      await launched.page.route('**/auth/v1/signup', (route) =>
        route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'over_email_send_rate_limit',
            message: 'provider detail must not reach the user'
          })
        })
      )
      await launched.page.getByRole('button', { name: 'Create account' }).click()
      await expect(
        launched.page.getByRole('alert').filter({
          hasText: 'Too many requests. Try again later.'
        })
      ).toBeVisible()
      await expect(
        launched.page.getByRole('heading', { name: 'Create your Nevix AI account' })
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
