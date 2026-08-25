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

test('a pending sign-in submission stays single-flight under repeated clicks', async ({
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

  const signInIndex = await enqueue(page, 'go', 'signIn', DEFER)
  await component.getByLabel('Email', { exact: true }).fill(memberUser.email)
  await component.getByLabel('Password', { exact: true }).fill('correct horse battery staple')
  await component.getByRole('button', { name: 'Sign in' }).click()
  await expect(component.getByRole('button', { name: 'Signing in…' })).toBeDisabled()
  await component.getByRole('button', { name: 'Signing in…' }).click({ force: true })
  await component.getByRole('button', { name: 'Signing in…' }).click({ force: true })

  const signIns = (await adapterCalls(page, 'go')).filter(
    (call) => (call as { operation: string }).operation === 'signIn'
  )
  expect(signIns).toHaveLength(1)

  await enqueue(page, 'sessions', 'replace', { outcome: 'persisted' })
  await enqueue(page, 'remembered', 'replace', { outcome: 'persisted' })
  await settle(page, signInIndex, { outcome: 'succeeded', session: memberSession(memberUser) })
  await expect(component.getByTestId('session-status')).toHaveText('available')
})

test('a pending sign-out stays single-flight under repeated clicks', async ({ mount, page }) => {
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

  const endSessionIndex = await enqueue(page, 'go', 'endSession', DEFER)
  await component.getByTestId('sign-out').click()
  await expect(component.getByTestId('session-signing-out')).toHaveText('true')
  await component.getByTestId('sign-out').click({ force: true })

  const ends = (await adapterCalls(page, 'go')).filter(
    (call) => (call as { operation: string }).operation === 'endSession'
  )
  expect(ends).toHaveLength(1)

  await enqueue(page, 'sessions', 'clear', { outcome: 'cleared' })
  await enqueue(page, 'go', 'probeSetup', {
    outcome: 'succeeded',
    initialized: true,
    setupCodeRequired: false
  })
  await settle(page, endSessionIndex, { outcome: 'revoked' })
  await expectLoginBoundary(page)
  await expect(component.getByTestId('session-signing-out')).toHaveCount(0)
})

test('remembered-email mutations serialize in selection order behind a slow clear', async ({
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

  // Uncheck while the clear hangs: the visible choice updates immediately,
  // and the later verified replacement cannot overtake it.
  const clearIndex = await enqueue(page, 'remembered', 'clear', DEFER)
  await component.getByLabel('Remember sign-in address', { exact: true }).uncheck()
  await expect(component.getByLabel('Remember sign-in address', { exact: true })).not.toBeChecked()

  // Re-select, then sign in: the replacement queues behind the pending clear.
  await component.getByLabel('Remember sign-in address', { exact: true }).check()
  await enqueue(page, 'go', 'signIn', { outcome: 'succeeded', session: memberSession(memberUser) })
  await enqueue(page, 'sessions', 'replace', { outcome: 'persisted' })
  await component.getByLabel('Email', { exact: true }).fill(memberUser.email)
  await component.getByLabel('Password', { exact: true }).fill('correct horse battery staple')
  await component.getByRole('button', { name: 'Sign in' }).click()
  await expect(component.getByTestId('session-status')).toHaveText('available')

  // The replacement has not overtaken the still-pending clear…
  const rememberedCalls = await adapterCalls(page, 'remembered')
  expect(rememberedCalls).toEqual([{ operation: 'read' }, { operation: 'clear' }])

  // …and completing the clear in order keeps the newer verified selection.
  const replaceIndex = await enqueue(page, 'remembered', 'replace', { outcome: 'persisted' })
  await settle(page, clearIndex, { outcome: 'cleared' })
  await expect
    .poll(async () =>
      (await adapterCalls(page, 'remembered')).filter(
        (call) => (call as { operation: string }).operation === 'replace'
      )
    )
    .toHaveLength(1)
  await settle(page, replaceIndex, { outcome: 'persisted' })
})

test('a failed clear reverts the preference and explains the limitation once', async ({
  mount,
  page
}) => {
  await prepareAuthenticationRuntime(page, {
    sessionRead: { outcome: 'empty' },
    rememberedRead: { outcome: 'remembered', email: memberUser.email, persistence: 'secure' },
    probeSetup: { outcome: 'succeeded', initialized: true, setupCodeRequired: false }
  })
  const component = await mount(<AuthenticationRuntimeStory />)
  await expectLoginBoundary(page)
  await expect(component.getByLabel('Email', { exact: true })).toHaveValue(memberUser.email)

  const clearIndex = await enqueue(page, 'remembered', 'clear', DEFER)
  await component.getByLabel('Remember sign-in address', { exact: true }).uncheck()

  const notice = component.getByText(
    'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
  )
  await settle(page, clearIndex, { outcome: 'clear-failed' })
  await expect(notice).toBeVisible()
  await expect(notice).toHaveCount(1)
  // The failed clear restores the selected preference and its value.
  await expect(component.getByLabel('Remember sign-in address', { exact: true })).toBeChecked()
  await expect(component.getByLabel('Email', { exact: true })).toHaveValue(memberUser.email)
})

test('a clear that fails after sign-in explains itself once on the authenticated surface', async ({
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

  const clearIndex = await enqueue(page, 'remembered', 'clear', DEFER)
  await component.getByLabel('Remember sign-in address', { exact: true }).uncheck()

  await enqueue(page, 'go', 'signIn', { outcome: 'succeeded', session: memberSession(memberUser) })
  await enqueue(page, 'sessions', 'replace', { outcome: 'persisted' })
  await component.getByLabel('Email', { exact: true }).fill(memberUser.email)
  await component.getByLabel('Password', { exact: true }).fill('correct horse battery staple')
  await component.getByRole('button', { name: 'Sign in' }).click()
  await expect(component.getByTestId('session-status')).toHaveText('available')

  await settle(page, clearIndex, { outcome: 'clear-failed' })
  const notice = component.getByText(
    'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
  )
  await expect(notice).toBeVisible()
  await expect(notice).toHaveCount(1)
})

test('a failed remembered-email replacement after login explains itself once on the authenticated surface', async ({
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
  await enqueue(page, 'remembered', 'replace', { outcome: 'replace-failed' })
  await component.getByLabel('Email', { exact: true }).fill(memberUser.email)
  await component.getByLabel('Password', { exact: true }).fill('correct horse battery staple')
  await component.getByRole('button', { name: 'Sign in' }).click()
  await expect(component.getByTestId('session-status')).toHaveText('available')

  const notice = component.getByText(
    'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
  )
  await expect(notice).toBeVisible()
  await expect(notice).toHaveCount(1)
})
