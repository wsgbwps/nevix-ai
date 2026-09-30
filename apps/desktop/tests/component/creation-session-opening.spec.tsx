import { expect, test } from '@playwright/experimental-ct-react'
import { CreationSessionOpeningStory } from './fixtures/creation-session-opening.story'

test('the newest source open wins when an older session read completes late', async ({
  mount,
  page
}) => {
  await mount(<CreationSessionOpeningStory />)
  await page.getByRole('button', { name: 'Open slow', exact: true }).click()
  await page.getByRole('button', { name: 'Open fast', exact: true }).click()
  await page.getByRole('button', { name: 'Complete fast', exact: true }).click()
  await expect(page.getByTestId('navigation-target')).toHaveText('fast')
  await page.getByRole('button', { name: 'Complete slow', exact: true }).click()
  await expect(page.getByTestId('open-outcomes')).toHaveText('fast:true,slow:false')
  await expect(page.getByTestId('navigation-target')).toHaveText('fast')
})

test('leaving the source opener makes a pending session read ineligible', async ({
  mount,
  page
}) => {
  await mount(<CreationSessionOpeningStory />)
  await page.getByRole('button', { name: 'Open slow', exact: true }).click()
  await page.getByRole('button', { name: 'Unmount opener', exact: true }).click()
  await page.getByRole('button', { name: 'Complete slow', exact: true }).click()
  await expect(page.getByTestId('open-outcomes')).toHaveText('slow:false')
  await expect(page.getByTestId('navigation-target')).toHaveText('inactive')
})

test('replacing the runtime makes the old session read ineligible', async ({ mount, page }) => {
  await mount(<CreationSessionOpeningStory />)
  await page.getByRole('button', { name: 'Open slow', exact: true }).click()
  await page.getByRole('button', { name: 'Replace runtime', exact: true }).click()
  await expect(page.getByTestId('current-user')).toHaveText('user-b')
  await page.getByRole('button', { name: 'Complete slow', exact: true }).click()
  await expect(page.getByTestId('open-outcomes')).toHaveText('slow:false')
  await expect(page.getByTestId('navigation-target')).toHaveText('inactive')
})

test('a rejected source read stays unsuccessful and leaves navigation unchanged', async ({
  mount,
  page
}) => {
  await mount(<CreationSessionOpeningStory />)
  await page.getByRole('button', { name: 'Open slow', exact: true }).click()
  await page.getByRole('button', { name: 'Reject slow', exact: true }).click()
  await expect(page.getByTestId('open-outcomes')).toHaveText('slow:false')
  await expect(page.getByTestId('navigation-target')).toHaveText('inactive')
})
