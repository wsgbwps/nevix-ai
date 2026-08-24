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

test('an open instance shows the claim wizard without a setup-code field', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'empty' },
    probeSetup: { outcome: 'succeeded', initialized: false, setupCodeRequired: false }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await expect(component.getByRole('heading', { name: 'Initialize Nevix AI' })).toBeVisible()
  await expect(component.getByText('Setup code', { exact: true })).toHaveCount(0)
  // An empty instance never offers the login it cannot satisfy.
  await expect(component.getByRole('heading', { name: 'Sign in to Nevix AI' })).toHaveCount(0)
})

test('a protected instance demands the setup code and validates it before claiming', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'empty' },
    probeSetup: { outcome: 'succeeded', initialized: false, setupCodeRequired: true }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await expect(
    component.getByText(
      'This deployment has no administrator yet. Enter the one-time setup code from the server operations log to create yours.'
    )
  ).toBeVisible()
  await expect(component.getByText('Setup code', { exact: true })).toHaveCount(1)

  // A wrong code keeps the wizard usable with its dedicated error.
  await enqueue(page, 'go', 'claimInstance', { outcome: 'invalid-setup-code' })
  await component.getByLabel('Email', { exact: true }).fill('first.admin@example.com')
  await component.getByLabel('Password', { exact: true }).fill('self-chosen-pass-1')
  await component.getByLabel('Confirm password', { exact: true }).fill('self-chosen-pass-1')
  await component.getByLabel('Setup code', { exact: true }).fill('WRONG-CODE')
  await component.getByRole('button', { name: 'Create administrator and continue' }).click()
  await expect(
    component.getByText(
      'The setup code is not valid. Check the latest code in the server operations log.'
    )
  ).toBeVisible()

  // The correct code establishes the session and the instance in one flow.
  await enqueue(page, 'go', 'claimInstance', {
    outcome: 'succeeded',
    session: {
      token: 'opaque-token-admin',
      expiresAt: '2027-01-01T00:00:00Z',
      user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'first.admin@example.com',
        displayName: 'first admin',
        role: 'admin',
        mustChangePassword: false
      }
    }
  })
  await enqueue(page, 'sessions', 'replace', { outcome: 'persisted' })
  await component.getByLabel('Setup code', { exact: true }).fill('AB23CD45')
  await component.getByRole('button', { name: 'Create administrator and continue' }).click()
  await expect(component.getByTestId('session-status')).toHaveText('available')
  await expect(component.getByTestId('session-role')).toHaveText('admin')
})

test('a failed setup probe shows a retryable error instead of guessing the instance state', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'empty' },
    probeSetup: { outcome: 'unavailable' }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await expect(component.getByRole('heading', { name: 'Server status unavailable' })).toBeVisible()
  await expect(component.getByRole('heading', { name: 'Sign in to Nevix AI' })).toHaveCount(0)
  await expect(component.getByRole('heading', { name: 'Initialize Nevix AI' })).toHaveCount(0)

  // The retry asks again; once the probe answers initialized, the boundary is
  // the ordinary sign-in.
  await enqueue(page, 'go', 'probeSetup', {
    outcome: 'succeeded',
    initialized: true,
    setupCodeRequired: false
  })
  await component.getByRole('button', { name: 'Try again' }).click()
  await expectLoginBoundary(page)
})

test('a lost concurrent claim returns to sign-in with a clear result', async ({ mount, page }) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'empty' },
    probeSetup: { outcome: 'succeeded', initialized: false, setupCodeRequired: false }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await component.getByLabel('Email', { exact: true }).fill('first.admin@example.com')
  await component.getByLabel('Password', { exact: true }).fill('self-chosen-pass-1')
  await component.getByLabel('Confirm password', { exact: true }).fill('self-chosen-pass-1')

  await enqueue(page, 'go', 'claimInstance', { outcome: 'already-claimed' })
  await component.getByRole('button', { name: 'Create administrator and continue' }).click()

  await expectLoginBoundary(page)
  await expect(
    component.getByText('This instance was already initialized. Sign in below.')
  ).toBeVisible()
  // The wizard never renders again for this boundary.
  await expect(component.getByRole('heading', { name: 'Initialize Nevix AI' })).toHaveCount(0)
})

test('a claim submission stays single-flight while the server decides', async ({ mount, page }) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'empty' },
    probeSetup: { outcome: 'succeeded', initialized: false, setupCodeRequired: false }
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await component.getByLabel('Email', { exact: true }).fill('first.admin@example.com')
  await component.getByLabel('Password', { exact: true }).fill('self-chosen-pass-1')
  await component.getByLabel('Confirm password', { exact: true }).fill('self-chosen-pass-1')
  const claimIndex = await enqueue(page, 'go', 'claimInstance', DEFER)
  await component.getByRole('button', { name: 'Create administrator and continue' }).click()

  await expect(component.getByRole('button', { name: 'Initializing…' })).toBeDisabled()
  const claims = (await adapterCalls(page, 'go')).filter(
    (call) => (call as { operation: string }).operation === 'claimInstance'
  )
  expect(claims).toHaveLength(1)

  await settle(page, claimIndex, { outcome: 'already-claimed' })
  await expectLoginBoundary(page)
})

test('a stale probe answer never overwrites a newer boundary', async ({ mount, page }) => {
  // The first probe stays pending while the user signs in; after sign-out a
  // newer probe settles the boundary, and the stale answer must not reopen
  // the setup wizard afterwards.
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'empty' },
    probeSetup: DEFER
  })
  const component = await mount(<AuthenticationRuntimeStory />)

  await expect(component.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible()

  await enqueue(page, 'go', 'signIn', { outcome: 'succeeded', session: memberSession(memberUser) })
  await enqueue(page, 'sessions', 'replace', { outcome: 'persisted' })
  await enqueue(page, 'remembered', 'replace', { outcome: 'persisted' })
  await component.getByLabel('Email', { exact: true }).fill(memberUser.email)
  await component.getByLabel('Password', { exact: true }).fill('correct horse battery staple')
  await component.getByRole('button', { name: 'Sign in' }).click()
  await expect(component.getByTestId('session-status')).toHaveText('available')

  // The sign-out boundary runs the newer probe immediately.
  await enqueue(page, 'go', 'endSession', { outcome: 'revoked' })
  await enqueue(page, 'sessions', 'clear', { outcome: 'cleared' })
  await enqueue(page, 'go', 'probeSetup', {
    outcome: 'succeeded',
    initialized: true,
    setupCodeRequired: false
  })
  await component.getByTestId('sign-out').click()
  await expectLoginBoundary(page)

  // The stale probe finally answers "uninitialized": the boundary must stay
  // on sign-in instead of reopening the wizard.
  await settle(page, 0, {
    outcome: 'succeeded',
    initialized: false,
    setupCodeRequired: false
  })
  await page.waitForTimeout(150)
  await expectLoginBoundary(page)
  await expect(component.getByRole('heading', { name: 'Initialize Nevix AI' })).toHaveCount(0)
})
