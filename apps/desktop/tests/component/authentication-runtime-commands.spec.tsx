import { expect, test, type Locator } from '@playwright/experimental-ct-react'
import { AuthenticationRuntimeStory } from './fixtures/authentication-runtime.story'
import {
  adapterCalls,
  enqueue,
  expectLoginBoundary,
  memberSession,
  memberUser,
  prepareAuthenticationRuntime
} from './fixtures/authentication-runtime-helpers'

async function signInFromBoundary(
  component: Locator,
  credentials: { readonly email: string; readonly password: string }
): Promise<void> {
  await component.getByLabel('Email', { exact: true }).fill(credentials.email)
  await component.getByLabel('Password', { exact: true }).fill(credentials.password)
  await component.getByRole('button', { name: 'Sign in' }).click()
}

test('a successful sign-in establishes the current session and enters the shell state', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'empty' },
    probeSetup: { outcome: 'succeeded', initialized: true, setupCodeRequired: false }
  })
  const component = await mount(<AuthenticationRuntimeStory />)
  await expectLoginBoundary(page)

  await enqueue(page, 'go', 'signIn', { outcome: 'succeeded', session: memberSession(memberUser) })
  await enqueue(page, 'sessions', 'replace', { outcome: 'persisted' })
  await enqueue(page, 'remembered', 'replace', { outcome: 'persisted' })
  await signInFromBoundary(component, {
    email: memberUser.email,
    password: 'correct horse battery staple'
  })
  await expect(component.getByTestId('session-status')).toHaveText('available')
  await expect(component.getByTestId('session-email')).toHaveText(memberUser.email)
  await expect(component.getByTestId('session-role')).toHaveText('member')
  await expect(component.getByRole('heading', { name: 'Sign in to Nevix AI' })).toHaveCount(0)

  await component.getByTestId('acquire-session').click()
  await expect(component.getByTestId('acquisition-result')).toHaveText(
    memberSession(memberUser).token
  )
})

test('unknown and incorrect credentials share one safe error', async ({ mount, page }) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'empty' },
    probeSetup: { outcome: 'succeeded', initialized: true, setupCodeRequired: false }
  })
  const component = await mount(<AuthenticationRuntimeStory />)
  await expectLoginBoundary(page)

  await enqueue(page, 'go', 'signIn', { outcome: 'invalid-credentials' })
  await component.getByLabel('Email', { exact: true }).fill('unknown@example.com')
  await component.getByLabel('Password', { exact: true }).fill('whatever-password-1')
  await component.getByRole('button', { name: 'Sign in' }).click()
  await expect(component.getByText('Email or password is incorrect')).toBeVisible()
  await expect(component.getByTestId('session-status')).toHaveText('unavailable')

  // The form stays usable for the next attempt.
  await enqueue(page, 'go', 'signIn', { outcome: 'invalid-credentials' })
  await component.getByLabel('Password', { exact: true }).fill('another-attempt-2')
  await component.getByRole('button', { name: 'Sign in' }).click()
  await expect(component.getByText('Email or password is incorrect')).toHaveCount(1)
})

test('a disabled account and a rate-limited attempt keep their distinct verdicts', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'empty' },
    probeSetup: { outcome: 'succeeded', initialized: true, setupCodeRequired: false }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await enqueue(page, 'go', 'signIn', { outcome: 'account-disabled' })
  await component.getByLabel('Email', { exact: true }).fill('disabled@example.com')
  await component.getByLabel('Password', { exact: true }).fill('whatever-password-1')
  await component.getByRole('button', { name: 'Sign in' }).click()
  await expect(
    component.getByText('This account has been disabled. Contact your administrator.')
  ).toBeVisible()
  await expect(component.getByTestId('session-status')).toHaveText('unavailable')

  await enqueue(page, 'go', 'signIn', { outcome: 'rate-limited' })
  await component.getByLabel('Password', { exact: true }).fill('whatever-password-2')
  await component.getByRole('button', { name: 'Sign in' }).click()
  await expect(component.getByText('Too many attempts. Try again later.')).toBeVisible()
})

test('a join-code holder self-registers from the owned surface into the shell', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'empty' },
    probeSetup: { outcome: 'succeeded', initialized: true, setupCodeRequired: false }
  })
  const component = await mount(<AuthenticationRuntimeStory />)
  await expectLoginBoundary(page)

  await component.getByRole('button', { name: 'Register with a join code' }).click()
  await expect(component.getByRole('heading', { name: 'Register with Nevix AI' })).toBeVisible()

  await enqueue(page, 'go', 'register', { outcome: 'invalid-join-code' })
  await component.getByLabel('Email', { exact: true }).fill('new.member@example.com')
  await component.getByLabel('Password', { exact: true }).fill('self-chosen-pass-1')
  await component.getByLabel('Confirm password', { exact: true }).fill('self-chosen-pass-1')
  await component.getByLabel('Join code', { exact: true }).fill('REVOKED-CODE')
  await component.getByRole('button', { name: 'Register' }).click()
  await expect(
    component.getByText('The join code is not valid. Contact your administrator.')
  ).toBeVisible()

  await enqueue(page, 'go', 'register', {
    outcome: 'succeeded',
    session: memberSession({ ...memberUser, email: 'new.member@example.com' })
  })
  await enqueue(page, 'sessions', 'replace', { outcome: 'persisted' })
  await component.getByLabel('Join code', { exact: true }).fill('VALID-CODE')
  await component.getByRole('button', { name: 'Register' }).click()
  await expect(component.getByTestId('session-status')).toHaveText('available')
  await expect(component.getByTestId('session-email')).toHaveText('new.member@example.com')
})

test('the forced password change handles validation, wrong current password, and success', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'empty' },
    probeSetup: { outcome: 'succeeded', initialized: true, setupCodeRequired: false }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await enqueue(page, 'go', 'signIn', {
    outcome: 'succeeded',
    session: memberSession({ ...memberUser, mustChangePassword: true })
  })
  await enqueue(page, 'sessions', 'replace', { outcome: 'persisted' })
  await enqueue(page, 'remembered', 'replace', { outcome: 'persisted' })
  await component.getByLabel('Email', { exact: true }).fill(memberUser.email)
  await component.getByLabel('Password', { exact: true }).fill('initial-horse-battery')
  await component.getByRole('button', { name: 'Sign in' }).click()

  await expect(component.getByRole('heading', { name: 'Set a new password' })).toBeVisible()
  await expect(component.getByTestId('session-status')).toHaveText('unavailable')

  // A too-short new password never reaches the server: the live policy
  // feedback keeps the submit disabled.
  await component.getByLabel('Initial password', { exact: true }).fill('initial-horse-battery')
  await component.getByLabel('New password', { exact: true }).fill('short')
  await component.getByLabel('Confirm new password', { exact: true }).fill('short')
  await expect(component.getByText('Password is too short.')).toBeVisible()
  await expect(
    component.getByRole('button', { name: 'Update password and continue' })
  ).toBeDisabled()
  const changes = (await adapterCalls(page, 'go')).filter(
    (call) => (call as { operation: string }).operation === 'changePassword'
  )
  expect(changes).toHaveLength(0)

  // A wrong current password keeps the boundary with its specific error.
  await component.getByLabel('New password', { exact: true }).fill('self-chosen-pass-1')
  await component.getByLabel('Confirm new password', { exact: true }).fill('self-chosen-pass-1')
  await enqueue(page, 'go', 'changePassword', { outcome: 'invalid-current-password' })
  await component.getByRole('button', { name: 'Update password and continue' }).click()
  await expect(component.getByText('The initial password is incorrect')).toBeVisible()

  // A successful change opens the shell on the same session.
  await enqueue(page, 'go', 'changePassword', { outcome: 'succeeded' })
  await enqueue(page, 'sessions', 'replace', { outcome: 'persisted' })
  await component.getByRole('button', { name: 'Update password and continue' }).click()
  await expect(component.getByTestId('session-status')).toHaveText('available')
  await expect(component.getByTestId('session-email')).toHaveText(memberUser.email)
})

test('a session rejected during the forced change dies locally with the expiry notice', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'empty' },
    probeSetup: { outcome: 'succeeded', initialized: true, setupCodeRequired: false }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await enqueue(page, 'go', 'signIn', {
    outcome: 'succeeded',
    session: memberSession({ ...memberUser, mustChangePassword: true })
  })
  await enqueue(page, 'sessions', 'replace', { outcome: 'persisted' })
  await enqueue(page, 'remembered', 'replace', { outcome: 'persisted' })
  await component.getByLabel('Email', { exact: true }).fill(memberUser.email)
  await component.getByLabel('Password', { exact: true }).fill('initial-horse-battery')
  await component.getByRole('button', { name: 'Sign in' }).click()
  await expect(component.getByRole('heading', { name: 'Set a new password' })).toBeVisible()

  await component.getByLabel('Initial password', { exact: true }).fill('initial-horse-battery')
  await component.getByLabel('New password', { exact: true }).fill('self-chosen-pass-1')
  await component.getByLabel('Confirm new password', { exact: true }).fill('self-chosen-pass-1')
  await enqueue(page, 'go', 'changePassword', { outcome: 'session-rejected' })
  await enqueue(page, 'sessions', 'clear', { outcome: 'cleared' })
  await enqueue(page, 'go', 'probeSetup', {
    outcome: 'succeeded',
    initialized: true,
    setupCodeRequired: false
  })
  await component.getByRole('button', { name: 'Update password and continue' }).click()

  await expectLoginBoundary(page)
  await expect(component.getByText('Your session is no longer valid. Sign in again.')).toBeVisible()
})

test('signing out ends local access, clears the stored session, and kills earlier acquisitions', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'empty' },
    probeSetup: { outcome: 'succeeded', initialized: true, setupCodeRequired: false }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await enqueue(page, 'go', 'signIn', { outcome: 'succeeded', session: memberSession(memberUser) })
  await enqueue(page, 'sessions', 'replace', { outcome: 'persisted' })
  await enqueue(page, 'remembered', 'replace', { outcome: 'persisted' })
  await component.getByLabel('Email', { exact: true }).fill(memberUser.email)
  await component.getByLabel('Password', { exact: true }).fill('correct horse battery staple')
  await component.getByRole('button', { name: 'Sign in' }).click()
  await expect(component.getByTestId('session-status')).toHaveText('available')

  // A peer-style caller captures the acquisition capability while the session
  // is available, before signing out.
  await component.getByTestId('capture-capability').click()
  await enqueue(page, 'go', 'endSession', { outcome: 'revoked' })
  await enqueue(page, 'sessions', 'clear', { outcome: 'cleared' })
  await enqueue(page, 'go', 'probeSetup', {
    outcome: 'succeeded',
    initialized: true,
    setupCodeRequired: false
  })
  await component.getByTestId('sign-out').click()

  await expectLoginBoundary(page)
  expect(await adapterCalls(page, 'sessions')).toEqual([
    { operation: 'read' },
    { operation: 'replace', session: memberSession(memberUser) },
    { operation: 'clear' }
  ])

  // The captured capability must now report the session unavailable.
  await component.getByTestId('acquire-session').click()
  await expect(component.getByTestId('acquisition-result')).toHaveText('unavailable')
})

test('an unconfirmed remote sign-out still ends local access with the delayed-revocation notice', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'empty' },
    probeSetup: { outcome: 'succeeded', initialized: true, setupCodeRequired: false }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await enqueue(page, 'go', 'signIn', { outcome: 'succeeded', session: memberSession(memberUser) })
  await enqueue(page, 'sessions', 'replace', { outcome: 'persisted' })
  await enqueue(page, 'remembered', 'replace', { outcome: 'persisted' })
  await component.getByLabel('Email', { exact: true }).fill(memberUser.email)
  await component.getByLabel('Password', { exact: true }).fill('correct horse battery staple')
  await component.getByRole('button', { name: 'Sign in' }).click()
  await expect(component.getByTestId('session-status')).toHaveText('available')

  await enqueue(page, 'go', 'endSession', { outcome: 'unconfirmed' })
  await enqueue(page, 'sessions', 'clear', { outcome: 'cleared' })
  await enqueue(page, 'go', 'probeSetup', {
    outcome: 'succeeded',
    initialized: true,
    setupCodeRequired: false
  })
  await component.getByTestId('sign-out').click()

  await expectLoginBoundary(page)
  await expect(
    component.getByText(
      'This device is signed out. Revoking the session on the server may be delayed.'
    )
  ).toBeVisible()
})

test('declining the forced password change ends only the current-device session', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'empty' },
    probeSetup: { outcome: 'succeeded', initialized: true, setupCodeRequired: false }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await enqueue(page, 'go', 'signIn', {
    outcome: 'succeeded',
    session: memberSession({ ...memberUser, mustChangePassword: true })
  })
  await enqueue(page, 'sessions', 'replace', { outcome: 'persisted' })
  await enqueue(page, 'remembered', 'replace', { outcome: 'persisted' })
  await component.getByLabel('Email', { exact: true }).fill(memberUser.email)
  await component.getByLabel('Password', { exact: true }).fill('initial-horse-battery')
  await component.getByRole('button', { name: 'Sign in' }).click()
  await expect(component.getByRole('heading', { name: 'Set a new password' })).toBeVisible()

  await enqueue(page, 'go', 'endSession', { outcome: 'revoked' })
  await enqueue(page, 'sessions', 'clear', { outcome: 'cleared' })
  await enqueue(page, 'go', 'probeSetup', {
    outcome: 'succeeded',
    initialized: true,
    setupCodeRequired: false
  })
  await component.getByRole('button', { name: 'Sign out without changing' }).click()

  await expectLoginBoundary(page)
})
