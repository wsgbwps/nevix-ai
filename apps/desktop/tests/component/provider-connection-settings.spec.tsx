import { expect, test, type Locator, type Page } from '@playwright/experimental-ct-react'
import {
  ProviderConnectionAdminConfiguredStory,
  ProviderConnectionAdminEmptyStory,
  ProviderConnectionCredentialUnavailableStory,
  ProviderConnectionMemberAvailableStory,
  ProviderConnectionMemberPausedStory
} from './fixtures/provider-connection-settings.story'

/**
 * Component coverage for the AI Creation Settings card (issue #157): the
 * admin lifecycle states (no connection, configured, credential recovery),
 * the proof-gated commands, stable error advice, and the member
 * status-only surface — driven through visible UI and the recorded wire
 * calls only.
 */

// Radix portals dialogs into document.body, outside the component scope;
// dialog queries go through the page.
async function openCredentialDialog(component: Locator): Promise<void> {
  await component.getByRole('button', { name: /Configure connection|Replace key/ }).click()
}

async function submitCredentialDialog(page: Page, key: string): Promise<void> {
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Kapon key').fill(key)
  await dialog.getByRole('button', { name: 'Verify and save' }).click()
}

test('admin sees the empty state and configures through a proof-gated command', async ({
  mount,
  page
}) => {
  const component = await mount(<ProviderConnectionAdminEmptyStory />)
  await expect(component.getByText('No AI provider connection is configured yet')).toBeVisible()

  await openCredentialDialog(component)
  await submitCredentialDialog(page, 'story-key')
  await expect(component.getByText('Valid')).toBeVisible()
  await expect(component.getByText('Available').first()).toBeVisible()

  const proofCalls = await page.evaluate(() => window.__providerConnectionTest?.proofCalls() ?? [])
  expect(proofCalls).toEqual(['create'])
  const wireCalls = await page.evaluate(() => window.__providerConnectionTest?.wireCalls() ?? [])
  expect(wireCalls).toContainEqual({ method: 'POST', path: '/creation/provider-connection' })
})

test('a transport-refused candidate shows stable advice and keeps the empty state', async ({
  mount,
  page
}) => {
  const component = await mount(<ProviderConnectionAdminEmptyStory />)
  await page.evaluate(() =>
    window.__providerConnectionTest?.respondConfigureWith('secure-transport')
  )
  await openCredentialDialog(component)
  await submitCredentialDialog(page, 'story-key')

  await expect(component.getByText(/requires a proven HTTPS connection/i)).toBeVisible()
  await expect(component.getByText('No AI provider connection is configured yet')).toBeVisible()
})

test('credential_unavailable surfaces recovery guidance without leaking internals', async ({
  mount
}) => {
  const component = await mount(<ProviderConnectionCredentialUnavailableStory />)
  await expect(component.getByText('Key unavailable')).toBeVisible()
  await expect(
    component.getByText(/Re-entering the Kapon key recovers the connection/i)
  ).toBeVisible()
  // The recovery path is the replace command, reachable without navigation.
  await expect(component.getByRole('button', { name: 'Replace key' })).toBeVisible()
})

test('pause and delete run admin-session and proof-gated commands respectively', async ({
  mount,
  page
}) => {
  const component = await mount(<ProviderConnectionAdminConfiguredStory />)

  await component.getByRole('button', { name: 'Pause' }).click()
  await expect(component.getByText('Paused')).toBeVisible()
  const wireCalls = await page.evaluate(() => window.__providerConnectionTest?.wireCalls() ?? [])
  expect(wireCalls).toContainEqual({ method: 'PATCH', path: '/creation/provider-connection' })

  await component.getByRole('button', { name: 'Delete connection' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete connection' }).click()
  await expect(component.getByText('No AI provider connection is configured yet')).toBeVisible()
  const proofCalls = await page.evaluate(() => window.__providerConnectionTest?.proofCalls() ?? [])
  expect(proofCalls).toContain('delete')
})

test('the member surface renders status-only advice for a paused connection', async ({ mount }) => {
  const component = await mount(<ProviderConnectionMemberPausedStory />)
  await expect(component.getByText('Image generation', { exact: true })).toBeVisible()
  await expect(component.getByText('Video generation', { exact: true })).toBeVisible()
  await expect(component.getByText('Unavailable').first()).toBeVisible()
  await expect(component.getByText('Please contact your administrator.')).toHaveCount(2)
  await expect(component.getByRole('button', { name: 'Pause' })).toHaveCount(0)
  await expect(component.getByRole('button', { name: 'Configure connection' })).toHaveCount(0)
})

test('the healthy member surface shows both media available', async ({ mount }) => {
  const component = await mount(<ProviderConnectionMemberAvailableStory />)
  await expect(component.getByText('Available')).toHaveCount(2)
  await expect(component.getByText('Please contact your administrator.')).toHaveCount(0)
})
