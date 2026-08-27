import { expect, test, type Page } from '@playwright/experimental-ct-react'
import {
  CreationWorkbenchEmptyStory,
  CreationWorkbenchStory
} from './fixtures/creation-workbench.story'

function controls(page: Page): {
  uploadCalls: () => Promise<ReadonlyArray<{ sessionId: string; name: string }>>
  deleteMaterialCalls: () => Promise<string[]>
} {
  return {
    uploadCalls: () => page.evaluate(() => window.__creationPileTest?.uploadCalls() ?? []),
    deleteMaterialCalls: () =>
      page.evaluate(() => window.__creationPileTest?.deleteMaterialCalls() ?? [])
  }
}

test('an empty library shows every explicit state: list, empty note, workspace empty', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchEmptyStory />)

  const workbench = page.getByTestId('creation-workbench')
  await expect(workbench).toBeVisible()
  await expect(workbench.getByRole('complementary')).toContainText(
    'No creation sessions yet; start from a blank draft'
  )
  await expect(workbench.getByText('Pick or create a session to start your work')).toBeVisible()
})

test('a creator opens a session, sees the pile expand on hover, scrolls, and adds material via keyboard', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory />)
  const { uploadCalls } = controls(page)

  const workbench = page.getByTestId('creation-workbench')
  await expect(workbench.getByText('Spring campaign')).toBeVisible()

  // Unnamed sessions fall back to the localized label — never an empty string.
  await expect(
    workbench.getByRole('button', { name: 'Untitled creation', exact: true })
  ).toBeVisible()

  // Selecting a session loads its pile with thumbnails for image kinds.
  await workbench.getByRole('button', { name: 'Spring campaign', exact: true }).click()
  const pile = page.getByTestId('reference-pile')
  await expect(pile).toBeVisible()
  await expect(pile.locator('[role="listitem"]')).toHaveCount(3)
  await expect(pile.locator('img').first()).toBeVisible()

  // Keyboard equivalence: Tab reaches the first card, ArrowRight moves real
  // DOM focus to the next card, and Delete removes the focused card through
  // its port — the exact interaction a hover user gets.
  const firstCard = pile.getByRole('listitem').first()
  await firstCard.focus()
  await expect(firstCard).toBeFocused()
  await page.keyboard.press('ArrowRight')
  const secondCard = pile.getByRole('listitem').nth(1)
  await expect(secondCard).toBeFocused()
  await page.keyboard.press('Delete')
  await expect
    .poll(() => page.evaluate(() => window.__creationPileTest?.deleteMaterialCalls() ?? []))
    .toEqual(['dddddddd-0000-4000-8000-000000000004'])
  // After deleting one card the remaining rows stay reachable.
  await expect(pile.getByRole('listitem').nth(1)).toHaveCount(1)

  // The add entry stays the last control; picking a file uploads it.
  await pile.getByLabel('Add reference material').focus()
  const fileChooserPromise = page.waitForEvent('filechooser')
  await page.keyboard.press('Enter')
  const chooser = await fileChooserPromise
  await chooser.setFiles({
    name: 'shot.png',
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47])
  })
  await expect
    .poll(uploadCalls)
    .toEqual([{ sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'shot.png' }])
})

test('the collapsed pile never scrolls the whole workbench: only its own layer overflows', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory />)

  await page
    .getByTestId('creation-workbench')
    .getByRole('button', { name: 'Spring campaign', exact: true })
    .click()

  // CT has no Tailwind runtime, so the structural contract is asserted on
  // class names: the pile's own strip is the only horizontal overflow layer.
  const collapsed = await page.getByTestId('pile-strip').getAttribute('class')
  expect(collapsed).toContain('overflow-hidden')

  await page.getByTestId('reference-pile').hover()
  await expect(page.locator('[role="listitem"]').first()).toBeVisible()

  const expanded = await page.getByTestId('pile-strip').getAttribute('class')
  expect(expanded).toContain('overflow-x-auto')

  const workbench = await page.getByTestId('creation-workbench').getAttribute('class')
  expect(workbench).not.toContain('overflow-x-auto')
  expect(workbench).not.toContain('overflow-hidden')
})
