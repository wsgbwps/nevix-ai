import { expect, test } from '@playwright/experimental-ct-react'
import { AuthenticationRuntimeStory } from './fixtures/authentication-runtime.story'
import {
  adapterCalls,
  DEFER,
  enqueue,
  expectLoginBoundary,
  memberSession,
  memberUser,
  prepareAuthenticationRuntime,
  settle
} from './fixtures/authentication-runtime-helpers'

test('an empty stored session settles on the ordinary sign-in boundary', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'empty' },
    probeSetup: { outcome: 'succeeded', initialized: true, setupCodeRequired: false }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await expect(component.getByText('Initializing authentication')).toBeVisible()
  await expectLoginBoundary(page)
  // The pre-authentication workflow stays internal: the external current
  // session never exposes restore or probe states.
  await expect(component.getByTestId('session-user-id')).toHaveCount(0)
})

test('a securely stored session restores into the current session without a fresh sign-in', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: {
      outcome: 'stored',
      credentials: { token: 'stored-opaque-token', expiresAt: '2027-01-01T00:00:00Z' }
    },
    rememberedRead: { outcome: 'empty' },
    validateSession: { outcome: 'succeeded', user: memberUser }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await expect(component.getByTestId('session-status')).toHaveText('available')
  await expect(component.getByTestId('session-email')).toHaveText(memberUser.email)
  await expect(component.getByTestId('session-role')).toHaveText('member')
  await expect(component.getByTestId('session-user-id')).toHaveText(memberUser.id)
  // Validation is the authority for account facts, and the owned surface
  // renders nothing once the session is available.
  await expect(component.getByRole('heading', { name: 'Sign in to Nevix AI' })).toHaveCount(0)

  await component.getByTestId('acquire-session').click()
  await expect(component.getByTestId('acquisition-result')).toHaveText('stored-opaque-token')
})

test('a stored session that still owes the password change stays on the owned surface', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: {
      outcome: 'stored',
      credentials: { token: 'gated-token', expiresAt: '2027-01-01T00:00:00Z' }
    },
    rememberedRead: { outcome: 'empty' },
    validateSession: { outcome: 'succeeded', user: { ...memberUser, mustChangePassword: true } }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await expect(component.getByRole('heading', { name: 'Set a new password' })).toBeVisible()
  // The gated session is unavailable outside the Domain: no partial user facts.
  await expect(component.getByTestId('session-status')).toHaveText('unavailable')
  await expect(component.getByTestId('session-email')).toHaveCount(0)
})

test('a temporary server outage keeps the restore retryable and the stored session alive', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: {
      outcome: 'stored',
      credentials: { token: 'stored-opaque-token', expiresAt: '2027-01-01T00:00:00Z' }
    },
    rememberedRead: { outcome: 'empty' },
    validateSession: { outcome: 'unavailable' }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await expect(
    component.getByRole('heading', { name: 'Your session could not be restored yet' })
  ).toBeVisible()
  expect(await adapterCalls(page, 'sessions')).toEqual([{ operation: 'read' }])

  // The retry re-reads both stores and validates again; the envelope is never deleted.
  await enqueue(page, 'sessions', 'read', {
    outcome: 'stored',
    credentials: { token: 'stored-opaque-token', expiresAt: '2027-01-01T00:00:00Z' }
  })
  await enqueue(page, 'remembered', 'read', { outcome: 'empty' })
  await enqueue(page, 'go', 'validateSession', { outcome: 'succeeded', user: memberUser })
  await component.getByRole('button', { name: 'Try again' }).first().click()
  await expect(component.getByTestId('session-status')).toHaveText('available')
  const sessionCalls = await adapterCalls(page, 'sessions')
  expect(sessionCalls).toEqual([{ operation: 'read' }, { operation: 'read' }])
})

test('an unreadable stored session is removed and explained on the sign-in boundary', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'unreadable' },
    rememberedRead: { outcome: 'empty' },
    probeSetup: { outcome: 'succeeded', initialized: true, setupCodeRequired: false }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await expectLoginBoundary(page)
  await expect(component.getByText('Your session is no longer valid. Sign in again.')).toBeVisible()
  expect(await adapterCalls(page, 'sessions')).toEqual([
    { operation: 'read' },
    { operation: 'clear' }
  ])
})

test('a rejected stored session dies locally and cannot be re-acquired', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: {
      outcome: 'stored',
      credentials: { token: 'rejected-token', expiresAt: '2027-01-01T00:00:00Z' }
    },
    rememberedRead: { outcome: 'empty' },
    validateSession: { outcome: 'session-rejected' },
    probeSetup: { outcome: 'succeeded', initialized: true, setupCodeRequired: false }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await expectLoginBoundary(page)
  await expect(component.getByText('Your session is no longer valid. Sign in again.')).toBeVisible()
  expect(await adapterCalls(page, 'sessions')).toEqual([
    { operation: 'read' },
    { operation: 'clear' }
  ])
})

test('an unavailable session store keeps the restore retryable without deleting anything', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'unavailable' },
    rememberedRead: { outcome: 'empty' }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await expect(
    component.getByRole('heading', { name: 'Your session could not be restored yet' })
  ).toBeVisible()
  expect(await adapterCalls(page, 'sessions')).toEqual([{ operation: 'read' }])
})

test('without a server URL the runtime stays dormant and performs no Authentication or persistence I/O', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {})
  const component = await mount(<AuthenticationRuntimeStory dormant />)

  await expect(component.getByTestId('session-status')).toHaveText('unavailable')
  await page.waitForTimeout(700)
  expect(await adapterCalls(page, 'go')).toEqual([])
  expect(await adapterCalls(page, 'sessions')).toEqual([])
  expect(await adapterCalls(page, 'remembered')).toEqual([])
})

test('a remembered email read back as memory-only explains itself once on the login surface', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'remembered', email: memberUser.email, persistence: 'memory-only' },
    probeSetup: { outcome: 'succeeded', initialized: true, setupCodeRequired: false }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await expectLoginBoundary(page)
  const notice = component.getByText(
    'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
  )
  await expect(notice).toBeVisible()
  await expect(notice).toHaveCount(1)
  // The remembered value still prefills the form.
  await expect(component.getByLabel('Email', { exact: true })).toHaveValue(memberUser.email)
})

test('a session persistence failure during sign-in keeps the live session and warns on the authenticated surface', async ({
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

  await enqueue(page, 'go', 'signIn', { outcome: 'succeeded', session: memberSession() })
  await enqueue(page, 'sessions', 'replace', { outcome: 'unavailable' })
  await enqueue(page, 'remembered', 'replace', { outcome: 'persisted' })
  await component.getByLabel('Email', { exact: true }).fill(memberUser.email)
  await component.getByLabel('Password', { exact: true }).fill('correct horse battery staple')
  await component.getByRole('button', { name: 'Sign in' }).click()

  // The live session continues even though the next launch will require a
  // fresh sign-in; the degradation notice is Authentication-owned.
  await expect(component.getByTestId('session-status')).toHaveText('available')
  await expect(
    component.getByText(
      'This device cannot store your session securely, so you will sign in again after closing the application.'
    )
  ).toBeVisible()
})

test('a deferred restore completes only when the server answers', async ({ mount, page }) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: {
      outcome: 'stored',
      credentials: { token: 'deferred-token', expiresAt: '2027-01-01T00:00:00Z' }
    },
    rememberedRead: { outcome: 'empty' },
    validateSession: DEFER
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await expect(component.getByText('Initializing authentication')).toBeVisible()
  await expect(component.getByTestId('session-status')).toHaveText('unavailable')

  await settle(page, 0, { outcome: 'succeeded', user: memberUser })
  await expect(component.getByTestId('session-status')).toHaveText('available')
})
