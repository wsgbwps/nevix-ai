import { expect, test } from '@playwright/experimental-ct-react'
import { CreationRuntimeProviderStory } from './fixtures/creation-runtime-provider.story'

test('owns runtime retirement across StrictMode replay and authenticated identities', async ({
  mount,
  page
}) => {
  await mount(<CreationRuntimeProviderStory />)

  await expect(page.getByTestId('current-runtime')).toHaveText('user-a:idle')
  await page.getByRole('button', { name: 'Retain current' }).click()
  await page.getByRole('button', { name: 'Change server' }).click()
  await expect(page.getByTestId('current-runtime')).toHaveText('user-a:idle')
  await page.getByRole('button', { name: 'Inspect retained' }).click()
  await expect(page.getByTestId('retained-runtime')).toHaveText('user-a:retired')

  await page.getByRole('button', { name: 'Retain current' }).click()
  await page.getByRole('button', { name: 'Change user' }).click()
  await expect(page.getByTestId('current-runtime')).toHaveText('user-b:idle')
  await page.getByRole('button', { name: 'Inspect retained' }).click()
  await expect(page.getByTestId('retained-runtime')).toHaveText('user-a:retired')

  await page.getByRole('button', { name: 'Retain current' }).click()
  await page.getByRole('button', { name: 'End session' }).click()
  await expect(page.getByTestId('current-runtime')).toHaveText('none')
  await page.getByRole('button', { name: 'Inspect retained' }).click()
  await expect(page.getByTestId('retained-runtime')).toHaveText('user-b:retired')
})
