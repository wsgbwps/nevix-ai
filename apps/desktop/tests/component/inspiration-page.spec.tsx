import { expect, test } from '@playwright/experimental-ct-react'
import { InspirationStory } from './fixtures/inspiration.story'

test('one member projection renders publication cards without legacy channel controls', async ({
  mount,
  page
}) => {
  await mount(<InspirationStory />)
  await expect(page.getByRole('heading', { name: 'Inspiration' })).toBeVisible()
  await expect(page.getByTestId('inspiration-card')).toHaveCount(1)
  await expect(page.getByText(/Official|Discovery/)).toHaveCount(0)
  await page.getByRole('button', { name: 'Open inspiration publication-1' }).focus()
  await expect(page.getByText('Aster')).toBeVisible()
})

test('the admin projection keeps published and restricted assets in the same wall', async ({
  mount,
  page
}) => {
  await mount(<InspirationStory state="admin" />)
  await expect(page.getByTestId('inspiration-card')).toHaveCount(2)
  await expect(page.getByText('Published')).toBeVisible()
  await expect(page.getByText('Restricted')).toBeVisible()
})

test('only server-authorized admin detail exposes keyboard-operable safety controls', async ({
  mount,
  page
}) => {
  await mount(<InspirationStory state="admin" />)
  await page.getByRole('button', { name: 'Open inspiration admin-asset' }).click()
  const dialog = page.getByRole('dialog')
  const assetRestriction = dialog.getByRole('region', { name: 'Asset restriction' })
  const publicationRestriction = dialog.getByRole('region', {
    name: 'Publication restriction'
  })
  await expect(assetRestriction).toContainText('Active')
  await expect(publicationRestriction).toContainText('Active')

  page.once('dialog', (confirmation) => void confirmation.accept())
  const releaseAsset = assetRestriction.getByRole('button', {
    name: 'Release asset restriction'
  })
  await releaseAsset.focus()
  await page.keyboard.press('Enter')
  await expect(assetRestriction).toContainText('Released')
  await expect(dialog.getByRole('status')).toContainText('Asset restriction released.')

  page.once('dialog', (confirmation) => void confirmation.accept())
  await publicationRestriction
    .getByRole('button', { name: 'Release publication restriction' })
    .click()
  await expect(publicationRestriction).toContainText('Released')
  await expect(dialog.getByRole('status')).toContainText('Publication restriction released.')
  expect(await page.evaluate(() => window.__inspirationTest?.safetyCalls())).toEqual([
    'release:asset:admin-asset',
    'release:publication:admin-publication'
  ])
})

test('member detail has no safety command entry points', async ({ mount, page }) => {
  await mount(<InspirationStory />)
  await page.getByRole('button', { name: 'Open inspiration publication-1' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('button', { name: /restriction/i })).toHaveCount(0)
  await expect(dialog.getByRole('region', { name: /restriction/i })).toHaveCount(0)
})

test('failed safety commands retain state and announce recovery feedback', async ({
  mount,
  page
}) => {
  await mount(<InspirationStory state="admin-safety-failed" />)
  await page.getByRole('button', { name: 'Open inspiration admin-asset' }).click()
  const dialog = page.getByRole('dialog')
  page.once('dialog', (confirmation) => void confirmation.accept())
  await dialog.getByRole('button', { name: 'Release asset restriction' }).click()
  await expect(dialog.getByRole('alert')).toContainText('The restriction could not be updated.')
  await expect(dialog.getByRole('region', { name: 'Asset restriction' })).toContainText('Active')
})

test('filters use the single projection and distinguish search-no-results', async ({
  mount,
  page
}) => {
  await mount(<InspirationStory />)
  await page.getByLabel('Media type').selectOption('image')
  await page.getByLabel('Publisher').fill('Aster')
  const search = page.getByTestId('inspiration-search')
  await expect(search).toHaveAccessibleName('Search')
  await search.fill('none')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByText('No content matches these filters.')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.__inspirationTest?.listCalls().at(-1)))
    .toMatchObject({ mediaType: 'image', creator: 'Aster', search: 'none' })
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page.getByTestId('inspiration-card')).toHaveCount(1)
})

test('loading errors expose one retry surface', async ({ mount, page }) => {
  await mount(<InspirationStory state="failed" />)
  await expect(page.getByRole('alert')).toContainText('Inspiration could not be loaded.')
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect
    .poll(() => page.evaluate(() => window.__inspirationTest?.listCalls().length))
    .toBeGreaterThan(1)
})

test('immersive detail shows full intent and uses a Publication for create similar', async ({
  mount,
  page
}) => {
  await mount(<InspirationStory />)
  await page.getByRole('button', { name: 'Open inspiration publication-1' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('A precise editorial launch scene')
  await expect(dialog).toContainText('archived-model')
  await expect(dialog).toContainText('Specification version1')
  await expect(dialog).toContainText('Capability manifest version2')
  await expect(dialog).toContainText('product-reference.png')
  await dialog.getByRole('button', { name: 'Preview' }).click()
  await expect(dialog.getByRole('img', { name: 'product-reference.png' })).toBeVisible()
  expect(await page.evaluate(() => window.__inspirationTest?.previewCalls())).toEqual([
    'reference-one'
  ])
  await dialog.getByRole('button', { name: 'Create similar' }).click()
  expect(await page.evaluate(() => window.__inspirationTest?.similarCalls())).toEqual([
    'publication-1'
  ])
})

test('an expired signed reference preview is authorized once more on element error', async ({
  mount,
  page
}) => {
  await mount(<InspirationStory state="preview-refresh" />)
  await page.getByRole('button', { name: 'Open inspiration publication-1' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Preview' }).click()
  await expect(dialog.getByRole('img', { name: 'product-reference.png' })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.__inspirationTest?.previewCalls()))
    .toEqual(['reference-one', 'reference-one'])

  await dialog
    .getByRole('img', { name: 'product-reference.png' })
    .evaluate((image) => image.dispatchEvent(new Event('error')))
  await expect
    .poll(() => page.evaluate(() => window.__inspirationTest?.previewCalls()))
    .toEqual(['reference-one', 'reference-one', 'reference-one'])
})

test('a failed signed-preview refresh stops after one automatic retry', async ({ mount, page }) => {
  await mount(<InspirationStory state="preview-refresh-failed" />)
  await page.getByRole('button', { name: 'Open inspiration publication-1' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Preview' }).click()
  await expect(dialog.getByRole('alert')).toContainText('could not be loaded')
  await expect(dialog.getByRole('img', { name: 'product-reference.png' })).toHaveCount(0)
  expect(await page.evaluate(() => window.__inspirationTest?.previewCalls())).toEqual([
    'reference-one',
    'reference-one'
  ])
})

test('waterfall chooses the shortest column and treats near-equal heights as a left-biased tie', async ({
  mount,
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await mount(<InspirationStory state="layout-probe" />)

  const card = (id: number): ReturnType<typeof page.getByTestId> =>
    page
      .getByTestId('inspiration-card')
      .filter({ has: page.getByRole('button', { name: `Open inspiration publication-${id}` }) })
  const [third, sixth, seventh, eighth] = await Promise.all(
    [3, 6, 7, 8].map(async (id) => {
      const box = await card(id).boundingBox()
      expect(box).not.toBeNull()
      return box!
    })
  )

  const thirdBottom = third.y + third.height
  const sixthBottom = sixth.y + sixth.height
  expect(thirdBottom - sixthBottom).toBeGreaterThanOrEqual(8)
  expect(thirdBottom - sixthBottom).toBeLessThanOrEqual(16)
  expect(seventh.x).toBeCloseTo(third.x, 0)
  expect(seventh.y).toBeCloseTo(thirdBottom + 2, 0)
  expect(eighth.x).toBeCloseTo(sixth.x, 0)
  expect(eighth.y).toBeCloseTo(sixthBottom + 2, 0)

  expect(
    await page
      .getByTestId('inspiration-card')
      .evaluateAll((cards) =>
        cards.map((card) => card.querySelector('button')?.getAttribute('aria-label'))
      )
  ).toEqual(Array.from({ length: 8 }, (_, index) => `Open inspiration publication-${index + 1}`))
})

test('waterfall recalculates its responsive column count', async ({ mount, page }) => {
  await page.setViewportSize({ width: 960, height: 600 })
  await mount(<InspirationStory state="dense" />)
  const cards = page.getByTestId('inspiration-card')
  await expect(cards).toHaveCount(24)
  const firstRowCount = async (): Promise<number> =>
    cards.evaluateAll((elements) => {
      const rects = elements.map((element) => element.getBoundingClientRect())
      return rects.filter((rect) => Math.abs(rect.top - rects[0].top) < 1).length
    })

  await expect.poll(firstRowCount).toBe(5)
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect.poll(firstRowCount).toBe(6)
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 1280)
})

test('failed media keeps the same precomputed shortest-column layout', async ({ mount, page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await mount(<InspirationStory state="layout-failed" />)
  await expect(page.getByText('Media failed to load').first()).toBeVisible()

  const cards = page.getByTestId('inspiration-card')
  const positions = await cards.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, top: rect.top, height: rect.height }
    })
  )
  expect(positions[6].left).toBeCloseTo(positions[2].left, 0)
  expect(positions[6].top).toBeCloseTo(positions[2].top + positions[2].height + 2, 0)
  expect(positions[7].left).toBeCloseTo(positions[5].left, 0)
})
