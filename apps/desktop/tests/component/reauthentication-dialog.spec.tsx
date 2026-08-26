import { expect, test, type Page } from '@playwright/experimental-ct-react'
import { ReauthenticationDialogStory } from './fixtures/reauthentication-dialog.story'

const issuedProof = {
  outcome: 'succeeded',
  value: {
    proof: 'opaque-proof-token',
    action: 'provider_connection.replace',
    expiresAt: '2026-09-01T00:05:00Z'
  }
} as const

function issueCalls(
  page: Page
): Promise<
  ReadonlyArray<{ readonly token: string; readonly action: string; readonly password: string }>
> {
  return page.evaluate(() => window.__reauthDialogTest?.issueCalls() ?? [])
}

function receivedProofs(page: Page): Promise<ReadonlyArray<unknown>> {
  return page.evaluate(() => window.__reauthDialogTest?.receivedProofs() ?? [])
}

function cancelCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__reauthDialogTest?.cancelCount() ?? 0)
}

async function enqueueIssue(page: Page, result: unknown): Promise<void> {
  await page.evaluate((next) => {
    window.__reauthDialogTest?.enqueueIssue(next)
  }, result)
}

test('a keyboard-only confirmation issues the declared exact action and delivers the proof', async ({
  mount,
  page
}) => {
  await mount(<ReauthenticationDialogStory />)

  const dialog = page.getByRole('dialog', { name: 'Confirm your current password' })
  await expect(dialog).toBeVisible()
  await enqueueIssue(page, issuedProof)

  // The dialog announces the action being authorized and the five-minute
  // single-use window before any input.
  await expect(dialog.getByText('Replace the provider key', { exact: true })).toBeVisible()
  await expect(dialog.getByText(/valid for 5 minutes and can be used once/)).toBeVisible()

  // Keyboard only: focus lands inside the dialog, the password is typed,
  // and Enter submits the form — no pointer involved.
  const password = dialog.getByLabel('Current password')
  await expect(password).toBeFocused()
  await page.keyboard.type('correct horse battery staple')
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('last-proof')).toHaveText('opaque-proof-token')

  expect(await issueCalls(page)).toEqual([
    {
      token: 'opaque-session-token',
      action: 'provider_connection.replace',
      password: 'correct horse battery staple'
    }
  ])
  expect(await receivedProofs(page)).toEqual([
    {
      proof: 'opaque-proof-token',
      action: 'provider_connection.replace',
      expiresAt: '2026-09-01T00:05:00Z'
    }
  ])
})

test('a wrong password announces the credential error and stays retryable', async ({
  mount,
  page
}) => {
  await mount(<ReauthenticationDialogStory />)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await enqueueIssue(page, {
    outcome: 'request-rejected',
    code: 'invalid_credentials'
  })
  const password = dialog.getByLabel('Current password')

  await password.fill('wrong-password-1')
  await dialog.getByRole('button', { name: 'Verify and continue' }).click()

  await expect(dialog.getByText('The current password is incorrect.')).toBeVisible()
  await expect(password).toHaveAttribute('aria-invalid', 'true')
  expect(await receivedProofs(page)).toEqual([])

  // The same surface retries with the correct password.
  await enqueueIssue(page, issuedProof)
  await password.fill('correct horse battery staple')
  await dialog.getByRole('button', { name: 'Verify and continue' }).click()
  await expect(page.getByTestId('last-proof')).toHaveText('opaque-proof-token')
})

test('the secure-transport failure keeps its own stable guidance', async ({ mount, page }) => {
  await mount(<ReauthenticationDialogStory />)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await enqueueIssue(page, {
    outcome: 'request-rejected',
    code: 'secure_transport_required'
  })

  await dialog.getByLabel('Current password').fill('correct horse battery staple')
  await dialog.getByRole('button', { name: 'Verify and continue' }).click()

  await expect(
    dialog.getByText('This connection cannot be proven as secure HTTPS transport')
  ).toBeVisible()
  expect(await receivedProofs(page)).toEqual([])
})

test('cancel and Escape abandon the confirmation without issuing', async ({ mount, page }) => {
  await mount(<ReauthenticationDialogStory />)
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(await cancelCount(page)).toBe(1)
  expect(await issueCalls(page)).toEqual([])

  // A reopened confirmation closes through Escape as well.
  await page.getByTestId('reopen-confirmation').click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect(await cancelCount(page)).toBe(2)
})

test('while submitting the dialog is not dismissable and shows the pending state', async ({
  mount,
  page
}) => {
  // No queued result: the request stays pending.
  await mount(<ReauthenticationDialogStory />)
  const dialog = page.getByRole('dialog')

  await dialog.getByLabel('Current password').fill('correct horse battery staple')
  await dialog.getByRole('button', { name: 'Verify and continue' }).click()

  await expect(dialog.getByRole('button', { name: 'Verifying…' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  expect(await cancelCount(page)).toBe(0)
})

test('each declared action is presented with its own label', async ({ mount, page }) => {
  await mount(<ReauthenticationDialogStory action="provider_connection.create" />)
  const dialog = page.getByRole('dialog')

  await expect(dialog.getByText('Set up the provider connection', { exact: true })).toBeVisible()
  await enqueueIssue(page, {
    outcome: 'request-rejected',
    code: 'invalid_credentials'
  })
  await dialog.getByLabel('Current password').fill('correct horse battery staple')
  await dialog.getByRole('button', { name: 'Verify and continue' }).click()

  expect(await issueCalls(page)).toEqual([
    {
      token: 'opaque-session-token',
      action: 'provider_connection.create',
      password: 'correct horse battery staple'
    }
  ])
})
