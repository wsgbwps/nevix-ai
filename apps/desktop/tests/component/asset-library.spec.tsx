import { expect, test } from '@playwright/experimental-ct-react'
import type { Locator, Page } from '@playwright/test'
import { AssetLibraryStory } from './fixtures/asset-library.story'

/** The header's mode control: the last button on the filters' row in either state. */
function batchModeControl(page: Page): Locator {
  return page.locator('[data-testid="asset-library"] > div').first().getByRole('button').last()
}

/** The border-and-padding group holding the three batch actions. */
function actionGroup(page: Page): Locator {
  return page.getByTestId('batch-toolbar').locator('div').first()
}

/** How far the action group paints past the filter strip's right edge. */
async function actionOverlap(page: Page): Promise<number> {
  return page.evaluate(() => {
    const filters = document.querySelector('[data-testid="asset-filters"]')!.getBoundingClientRect()
    const group = document
      .querySelector('[data-testid="batch-toolbar"] div')!
      .getBoundingClientRect()
    return Math.round(filters.right - group.left)
  })
}

/**
 * `sr-only` is a 1px box whatever font draws the text, so any wider label is one
 * that is drawn — a width, rather than a guess at a glyph's advance, which would
 * make the Chinese cases depend on the runner having a CJK font.
 */
const LABEL_HIDDEN_AT_OR_BELOW_PX = 2

/** Each action's label: 'shown' where it is drawn, 'icon-only' where it is not. */
async function actionLabelStates(page: Page): Promise<readonly string[]> {
  const widths = await actionGroup(page)
    .locator('button > span')
    .evaluateAll((spans) => spans.map((span) => Math.round(span.getBoundingClientRect().width)))
  return widths.map((width) => (width <= LABEL_HIDDEN_AT_OR_BELOW_PX ? 'icon-only' : 'shown'))
}

/** Each action's icon: 'drawn' where it stands in for the label, else 'hidden'. */
async function actionIconStates(page: Page): Promise<readonly string[]> {
  return actionGroup(page)
    .locator('button > svg')
    .evaluateAll((icons) =>
      icons.map((icon) => (icon.getBoundingClientRect().width > 0 ? 'drawn' : 'hidden'))
    )
}

for (const viewport of [
  { width: 960, height: 600 },
  { width: 1280, height: 800 }
]) {
  test(`asset wall stays bounded and usable at ${viewport.width}x${viewport.height}`, async ({
    mount,
    page
  }) => {
    await page.setViewportSize(viewport)
    await mount(<AssetLibraryStory />)
    await expect(page.getByRole('heading', { name: 'Assets' })).toBeVisible()
    await expect(page.getByTestId('asset-card')).toHaveCount(3)
    await expect(page.getByTestId('asset-group')).toHaveCount(2)
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', viewport.width)
  })
}

for (const viewport of [
  { width: 960, height: 600, columns: 5, filterRows: 1 },
  { width: 1280, height: 800, columns: 8, filterRows: 1 }
]) {
  test(`dense wall uses ${viewport.columns} compact columns at ${viewport.width}x${viewport.height}`, async ({
    mount,
    page
  }) => {
    await page.setViewportSize(viewport)
    await mount(<AssetLibraryStory dense />)
    const cards = page.getByTestId('asset-card')
    await expect(cards).toHaveCount(24)

    const layout = await cards.evaluateAll((elements) => {
      const rects = elements.map((element) => element.getBoundingClientRect())
      return {
        firstRowCount: rects.filter((rect) => Math.abs(rect.top - rects[0].top) < 1).length,
        minWidth: Math.min(...rects.map((rect) => rect.width)),
        maxWidth: Math.max(...rects.map((rect) => rect.width)),
        maxRight: Math.max(...rects.map((rect) => rect.right))
      }
    })
    expect(layout.firstRowCount).toBe(viewport.columns)
    expect(layout.minWidth).toBeGreaterThan(100)
    expect(layout.maxWidth).toBeLessThan(190)
    expect(layout.maxRight).toBeLessThanOrEqual(viewport.width)

    const filterRows = await page.getByTestId('asset-filters').evaluate((filters) => {
      // Controls only: the divider between them is shorter than a row.
      const tops = [...filters.querySelectorAll('button')].map((control) =>
        Math.round(control.getBoundingClientRect().top)
      )
      return new Set(tops).size
    })
    expect(filterRows).toBe(viewport.filterRows)
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', viewport.width)
  })
}

test('filters map to the page port and reset keyset position', async ({ mount, page }) => {
  await mount(<AssetLibraryStory />)
  await page
    .getByRole('group', { name: 'Media type' })
    .getByRole('button', { name: 'Video' })
    .click()
  await page.getByRole('button', { name: 'Time' }).click()
  await page.getByLabel('Start date').fill('2026-09-01')
  await page.getByLabel('End date').fill('2026-09-10')
  await page.getByRole('button', { name: 'Time' }).click()
  await page.getByRole('button', { name: 'Sort' }).click()
  await page.getByRole('menuitemradio', { name: 'Oldest first' }).click()
  await page.getByRole('button', { name: 'Filter' }).click()
  await page.getByText('Text to video').click()
  await page.getByText('First frame').click()
  await page.getByText('16:9').click()
  await page.getByText('720p').click()
  // Day boundaries are local, and the end date is sent as the next day's instant.
  const createdSince = new Date(2026, 8, 1).toISOString()
  const createdUntil = new Date(2026, 8, 11).toISOString()
  await expect
    .poll(() => page.evaluate(() => window.__assetLibraryTest?.listCalls().at(-1)))
    .toMatchObject({
      mediaType: 'video',
      createdSince,
      createdUntil,
      sort: 'oldest',
      modes: ['text-to-video', 'first-frame'],
      ratios: ['16:9'],
      resolutions: ['720p']
    })

  const callsBeforeResubmit = await page.evaluate(
    () => window.__assetLibraryTest?.listCalls().length ?? 0
  )
  await page
    .getByRole('group', { name: 'Media type' })
    .getByRole('button', { name: 'Image' })
    .click()
  await expect
    .poll(() => page.evaluate(() => window.__assetLibraryTest?.listCalls().at(-1)))
    .toMatchObject({ mediaType: 'image', modes: [], ratios: [], resolutions: [] })
  expect(await page.evaluate(() => window.__assetLibraryTest?.listCalls().length ?? 0)).toBe(
    callsBeforeResubmit + 1
  )
})

test('a facet selection is dropped by the clear row', async ({ mount, page }) => {
  await mount(<AssetLibraryStory />)
  await page.getByRole('button', { name: 'Filter' }).click()
  await page.getByText('Text to image').click()
  await expect
    .poll(() => page.evaluate(() => window.__assetLibraryTest?.listCalls().at(-1)))
    .toMatchObject({ modes: ['text-to-image'] })

  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect
    .poll(() => page.evaluate(() => window.__assetLibraryTest?.listCalls().at(-1)))
    .toMatchObject({ modes: [], ratios: [], resolutions: [] })
  await expect(page.getByRole('button', { name: 'Clear filters' })).toBeHidden()
})

test('the wall opens on images with only the type buttons offered', async ({ mount, page }) => {
  await mount(<AssetLibraryStory />)
  const types = page.getByRole('group', { name: 'Media type' }).getByRole('button')
  await expect(types).toHaveText(['Image', 'Video'])
  await expect(types.first()).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(() => page.evaluate(() => window.__assetLibraryTest?.listCalls().at(0)))
    .toMatchObject({ mediaType: 'image' })
})

test('the wall asks for the fixed thumbnail variant, and a video for the original', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory />)
  await expect
    .poll(() => page.evaluate(() => window.__assetLibraryTest?.displayCalls()))
    .toEqual([
      { id: 'asset-one', purpose: 'thumbnail' },
      { id: 'asset-two', purpose: 'preview' },
      { id: 'asset-three', purpose: 'thumbnail' }
    ])
})

test('wall display loading is capped at four concurrent authorizations', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory displayMode="deferred" />)
  await expect
    .poll(() => page.evaluate(() => window.__assetLibraryTest?.maxActiveDisplays()))
    .toBe(4)
  expect(await page.evaluate(() => window.__assetLibraryTest?.displayCalls().length)).toBe(4)
  await page.evaluate(() => window.__assetLibraryTest?.releaseDisplays())
  await expect
    .poll(() => page.evaluate(() => window.__assetLibraryTest?.displayCalls().length))
    .toBe(8)
})

test('a card paints the granted URL directly, without any content download', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory />)
  await expect(page.getByRole('img', { name: 'Asset asset-one' })).toBeVisible()
  // Display never streams the original, so nothing was downloaded to paint it.
  expect(await page.evaluate(() => window.__assetLibraryTest?.maxActiveDownloads())).toBe(0)
})

test('one failed authorization is retried automatically and then stops', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory displayMode="fail-once" />)
  // Two asks for the same card: the first failure spends the automatic retry.
  await expect
    .poll(() => page.evaluate(() => window.__assetLibraryTest?.displayCalls().length))
    .toBeGreaterThanOrEqual(6)
  await expect(page.getByRole('img', { name: 'Asset asset-one' })).toBeVisible()
  expect(await page.getByRole('button', { name: 'Retry' }).count()).toBe(0)
})

test('a persistent authorization failure stops at a manual retry', async ({ mount, page }) => {
  await mount(<AssetLibraryStory displayMode="always-fail" />)
  const retry = page.getByRole('button', { name: 'Retry' })
  await expect(retry.first()).toBeVisible()
  const spent = await page.evaluate(() => window.__assetLibraryTest?.displayCalls().length)
  // Three cards, one automatic retry each, and then nothing: the wall gave up
  // rather than looping.
  expect(spent).toBe(6)
  const assetOne = await page.evaluate(
    () => window.__assetLibraryTest?.displayCalls().filter((call) => call.id === 'asset-one').length
  )
  expect(assetOne).toBe(2)

  await page.evaluate(() => window.__assetLibraryTest?.resetDisplayAttempts())
  await retry.first().click()
  await expect
    .poll(() => page.evaluate(() => window.__assetLibraryTest?.displayCalls().length))
    .toBeGreaterThan(spent)
})

test('a gone asset shows the generic unavailable state and refreshes the list', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory displayMode="gone" />)
  await expect(page.getByText('Media unavailable').first()).toBeVisible()
  // Nothing to retry: the server already answered, so the list re-reads instead.
  expect(await page.getByRole('button', { name: 'Retry' }).count()).toBe(0)
  await expect
    .poll(
      async () => (await page.evaluate(() => window.__assetLibraryTest?.listCalls().length)) ?? 0
    )
    .toBeGreaterThan(1)
})

test('detail switches siblings and exposes the full publish confirmation facts', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory />)
  await page.getByRole('button', { name: 'Open asset asset-one' }).click()
  await expect(page.getByRole('dialog')).toContainText('A quiet launch scene')
  await expect(page.getByRole('button', { name: 'Create similar' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Publish to Inspiration' })).toBeEnabled()
  await expect(page.getByRole('dialog')).toContainText('Specification version1')
  await expect(page.getByRole('dialog')).toContainText('Capability manifest version4')
  await expect(page.getByRole('dialog')).toContainText('reference.png · reference · image')
  await page.getByRole('button', { name: 'Result 2' }).click()
  await expect(page.getByRole('dialog')).toContainText('asset-two')
  await expect(page.getByRole('dialog')).toContainText('Output duration3 s')
  await expect(page.getByRole('dialog')).toContainText('Quantity2')
  await expect(page.getByRole('dialog')).toContainText('Duration5 s')
  await page.getByRole('button', { name: 'Create similar' }).click()
  const reused = await page.evaluate(() => window.__assetLibraryTest?.reused() ?? [])
  expect(reused).toHaveLength(1)
  expect(reused[0]?.references).toHaveLength(1)
})

test('selecting the current sibling keeps its loaded detail visible', async ({ mount, page }) => {
  await mount(<AssetLibraryStory />)
  await page.getByRole('button', { name: 'Open asset asset-one' }).click()
  await expect(page.getByRole('dialog')).toContainText('A quiet launch scene')
  await page.getByRole('button', { name: 'Result 1' }).click()
  await expect(page.getByRole('dialog')).toContainText('A quiet launch scene')
})

test('create similar re-fetches the origin and refuses a stale asset', async ({ mount, page }) => {
  await mount(<AssetLibraryStory staleOnReuse />)
  await page.getByRole('button', { name: 'Open asset asset-one' }).click()
  await page.getByRole('button', { name: 'Create similar' }).click()

  await expect(page.getByRole('alert')).toContainText('no longer available')
  expect(await page.evaluate(() => window.__assetLibraryTest?.detailCalls())).toEqual([
    'asset-one',
    'asset-one'
  ])
  expect(await page.evaluate(() => window.__assetLibraryTest?.reused())).toEqual([])
})

test('create similar asks before replacing an existing new draft', async ({ mount, page }) => {
  await mount(<AssetLibraryStory replacementRequired />)
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Open asset asset-one' }).click()
  await page.getByRole('button', { name: 'Create similar' }).click()

  await expect
    .poll(() => page.evaluate(() => window.__assetLibraryTest?.replacements()))
    .toEqual([false, true])
})

test('create similar reports an unavailable local draft store without leaving the library', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory storageFailure />)
  await page.getByRole('button', { name: 'Open asset asset-one' }).click()
  await page.getByRole('button', { name: 'Create similar' }).click()

  await expect(page.getByRole('alert')).toContainText('no longer available')
  await expect(page.getByTestId('asset-library')).toBeAttached()
  expect(await page.evaluate(() => window.__assetLibraryTest?.reused())).toEqual([])
})

test('private origin and destructive actions stay gated by server capabilities', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory visibility="public" />)
  await page.getByRole('button', { name: 'Open asset asset-one' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).not.toContainText('A quiet launch scene')
  await expect(dialog.getByRole('button', { name: 'Create similar' })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Delete' })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Publish to Inspiration' })).toHaveCount(0)
})

test('publishing confirms the frozen facts and exposes withdrawal', async ({ mount, page }) => {
  await mount(<AssetLibraryStory />)
  await page.getByRole('button', { name: 'Open asset asset-one' }).click()
  page.once('dialog', async (confirmation) => {
    expect(confirmation.message()).toContain('complete generation specification')
    expect(confirmation.message()).toContain('1 used reference')
    await confirmation.accept()
  })
  await page.getByRole('button', { name: 'Publish to Inspiration' }).click()
  await expect(page.getByRole('button', { name: 'Withdraw publication' })).toBeVisible()
  expect(await page.evaluate(() => window.__assetLibraryTest?.publishKeys())).toHaveLength(1)

  page.once('dialog', (confirmation) => void confirmation.accept())
  await page.getByRole('button', { name: 'Withdraw publication' }).click()
  await expect(page.getByRole('button', { name: 'Publish to Inspiration' })).toBeVisible()
  expect(await page.evaluate(() => window.__assetLibraryTest?.withdraws())).toEqual([
    'publication-one'
  ])
})

test('deleting an asset states the result removal and the surviving Publication', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory />)
  await page.getByRole('button', { name: 'Open asset asset-one' }).click()
  page.once('dialog', async (confirmation) => {
    expect(confirmation.message()).toContain('result leaves the source task card')
    expect(confirmation.message()).toContain('removes that card')
    expect(confirmation.message()).toContain('publication will not be withdrawn')
    await confirmation.dismiss()
  })
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('batch mode offers three actions over the row and downloads sequentially', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory downloadMode="deferred" />)
  await page.getByRole('button', { name: 'Batch actions' }).click()
  const actions = page.getByRole('button', { name: 'Delete' })
  const download = page.getByRole('button', { name: 'Download', exact: true })
  const publish = page.getByRole('button', { name: 'Publish', exact: true })
  await expect(actions).toBeDisabled()
  await expect(download).toBeDisabled()
  await expect(publish).toBeDisabled()
  await expect(page.getByRole('status').filter({ hasText: '0 items selected' })).toBeVisible()
  await expect(page.getByTestId('batch-toolbar').getByRole('button')).toHaveCount(4)

  await page.getByRole('checkbox', { name: 'Select asset asset-one' }).check()
  await page.getByRole('checkbox', { name: 'Select asset asset-two' }).check()
  await expect(page.getByRole('status').filter({ hasText: '2 items selected' })).toBeVisible()
  await download.click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Download in progress 1 / 2' })
  ).toBeVisible()
  expect(await page.evaluate(() => window.__assetLibraryTest?.maxActiveDownloads())).toBe(1)
  await page.evaluate(() => window.__assetLibraryTest?.releaseDownloads())
  await expect(page.getByRole('status').filter({ hasText: '2 / 2' })).toBeVisible()
  expect(await page.evaluate(() => window.__assetLibraryTest?.maxActiveDownloads())).toBe(1)
})

test('batch download can be cancelled with an accessible stable status', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory downloadMode="cancelled" />)
  await page.getByRole('button', { name: 'Batch actions' }).click()
  await page.getByRole('checkbox', { name: 'Select asset asset-one' }).check()
  await page.getByRole('button', { name: 'Download', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel Download' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Download cancelled' })).toBeVisible()
})

test('batch delete runs per asset and re-reads the wall it changed', async ({ mount, page }) => {
  await mount(<AssetLibraryStory />)
  await page.getByRole('button', { name: 'Batch actions' }).click()
  await page.getByRole('checkbox', { name: 'Select asset asset-one' }).check()
  await page.getByRole('checkbox', { name: 'Select asset asset-three' }).check()
  page.once('dialog', async (confirmation) => {
    expect(confirmation.message()).toContain('Delete 2 selected assets?')
    expect(confirmation.message()).toContain('results leave their source task cards')
    expect(confirmation.message()).toContain('removes that card')
    expect(confirmation.message()).toContain('publications will not be withdrawn')
    await confirmation.accept()
  })
  await page.getByRole('button', { name: 'Delete' }).click()

  await expect(
    page.getByRole('status').filter({ hasText: 'Delete complete · 2 / 2' })
  ).toBeVisible()
  expect(await page.evaluate(() => window.__assetLibraryTest?.deletes())).toEqual([
    'asset-one',
    'asset-three'
  ])
  await expect
    .poll(() => page.evaluate(() => window.__assetLibraryTest?.listCalls().length ?? 0))
    .toBe(2)

  // The refresh dropped the deleted cards, so the selection must drop with
  // them: a count for cards that are gone would leave actions that confirm and
  // then silently do nothing.
  await expect(page.getByTestId('asset-card')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Delete' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeDisabled()
})

test('batch publish skips what the server would refuse and reports the skip', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory unpublishableIds={['asset-two']} />)
  await page.getByRole('button', { name: 'Batch actions' }).click()
  await page.getByRole('checkbox', { name: 'Select asset asset-one' }).check()
  await page.getByRole('checkbox', { name: 'Select asset asset-two' }).check()
  page.once('dialog', async (confirmation) => {
    expect(confirmation.message()).toContain('Publish 2 selected assets?')
    await confirmation.accept()
  })
  await page.getByRole('button', { name: 'Publish', exact: true }).click()

  await expect(
    page.getByRole('status').filter({ hasText: 'Published · 1 / 2 (1 not publishable, skipped)' })
  ).toBeVisible()
  expect(await page.evaluate(() => window.__assetLibraryTest?.publishKeys())).toHaveLength(1)
})

test('a selection with nothing publishable leaves publish unavailable', async ({ mount, page }) => {
  await mount(<AssetLibraryStory unpublishableIds={['asset-one']} />)
  await page.getByRole('button', { name: 'Batch actions' }).click()
  await page.getByRole('checkbox', { name: 'Select asset asset-one' }).check()

  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Delete' })).toBeEnabled()
})

test('a batch detached by a reset page cannot overwrite the batch that replaced it', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory downloadMode="sequenced" paginated />)
  await page.getByRole('button', { name: 'Batch actions' }).click()
  await page.getByRole('checkbox', { name: 'Select asset asset-one' }).check()
  await page.getByRole('button', { name: 'Download', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '1 / 1' })).toBeVisible()

  // Re-reading the wall under a new filter resets the page, which detaches the
  // running batch and drops its selection with it; the second page a short wall
  // appends is still there to pick from. A run in flight leaves no way out of
  // selection but cancelling it, so a filter is the detach the user can reach.
  await page
    .getByRole('group', { name: 'Media type' })
    .getByRole('button', { name: 'Video' })
    .click()
  await expect(page.getByTestId('asset-card')).toHaveCount(5)
  await page.getByRole('checkbox', { name: 'Select asset asset-four' }).check()
  await page.getByRole('button', { name: 'Download', exact: true }).click()

  // Releasing the detached batch's handle must not disturb the live one.
  await page.evaluate(() => window.__assetLibraryTest?.releaseNextDownload())
  await expect(
    page.getByRole('status').filter({ hasText: 'Download in progress 1 / 1' })
  ).toBeVisible()
  await page.getByRole('button', { name: 'Cancel Download' }).click()
  await page.evaluate(() => window.__assetLibraryTest?.releaseNextDownload())
  await expect(page.getByRole('status').filter({ hasText: 'Download cancelled' })).toBeVisible()
})

test('single download failure is announced instead of failing silently', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory downloadMode="failed" />)
  await page.getByRole('button', { name: 'Open asset asset-one' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Download' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Download failed' })).toBeVisible()
})

test('single download is aborted when its detail dialog closes', async ({ mount, page }) => {
  await mount(<AssetLibraryStory downloadMode="cancelled" />)
  await page.getByRole('button', { name: 'Open asset asset-one' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Download' }).click()
  await page.keyboard.press('Escape')
  await expect
    .poll(() => page.evaluate(() => window.__assetLibraryTest?.abortedDownloads()))
    .toBe(1)
})

test('a wall shorter than the scroller appends the next keyset page unasked', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory paginated />)

  await expect(page.getByTestId('asset-card')).toHaveCount(5)
  // The second page is the last one, so the sentinel retires with it.
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(() => window.__assetLibraryTest?.listCalls().map((call) => call.cursor))
    )
    .toEqual([null, 'next'])
})

test('a failed append keeps the wall and turns the sentinel into its retry', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory paginated append="fail-once" />)

  await expect(page.getByTestId('asset-card')).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByTestId('asset-card')).toHaveCount(5)
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0)
})

test('a server echoing the cursor it was handed stops the wall', async ({ mount, page }) => {
  await mount(<AssetLibraryStory paginated append="echo" />)

  await expect(page.getByTestId('asset-card')).toHaveCount(5)
  await expect
    .poll(() =>
      page.evaluate(() => window.__assetLibraryTest?.listCalls().map((call) => call.cursor))
    )
    .toEqual([null, 'next'])
})

test('a refresh after a mutation re-reads every loaded page, not just the first', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory paginated />)
  await expect(page.getByTestId('asset-card')).toHaveCount(5)

  await page.getByRole('button', { name: 'Open asset asset-one' }).click()
  page.once('dialog', (confirmation) => void confirmation.accept())
  await page.getByRole('button', { name: 'Publish to Inspiration' }).click()
  await expect(page.getByRole('button', { name: 'Withdraw publication' })).toBeVisible()

  await expect(page.getByTestId('asset-card')).toHaveCount(5)
  await expect
    .poll(() =>
      page.evaluate(() => window.__assetLibraryTest?.listCalls().map((call) => call.cursor))
    )
    .toEqual([null, 'next', null, 'next'])
})

// Entering the mode swaps a lone 32px icon button for a batch toolbar whose
// row is 38px (32px buttons in a 1px border and 2px padding) — so the header
// has a height it must not grow past here, in either of its two widths (labels
// shown, or icons standing in for them). The wall below is `flex-1` in that
// column, which is what turns that growth into a 6px jump under the pointer.
// The row's width is the other half of the contract: see the overlap tests at
// the end of this file.
for (const viewport of [
  { width: 960, height: 600, language: 'en' },
  { width: 960, height: 600, language: 'zh-CN' },
  { width: 1280, height: 800, language: 'en' }
] as const) {
  test(`entering batch mode leaves the wall where it was at ${viewport.width} in ${viewport.language}`, async ({
    mount,
    page
  }) => {
    await page.setViewportSize(viewport)
    await mount(<AssetLibraryStory />)
    await page.evaluate((next) => window.__assetLibraryTest?.setLanguage(next), viewport.language)
    const wall = page.getByTestId('asset-library').locator('> div').nth(1)
    const card = page.getByTestId('asset-card').first()
    await expect(card).toBeVisible()

    const top = async (locator: Locator): Promise<number> =>
      (await locator.boundingBox())?.y ?? Number.NaN
    const before = { wall: await top(wall), card: await top(card) }

    await batchModeControl(page).click()
    await expect(page.getByTestId('batch-toolbar')).toBeVisible()

    expect({
      wall: (await top(wall)) - before.wall,
      card: (await top(card)) - before.card
    }).toEqual({ wall: 0, card: 0 })
  })
}

// The batch toolbar shares the filter strip's row, and its labelled content is
// wider than the box the strip leaves it: English's filter strip is 366px wide,
// so the toolbar's box is the window minus 256 sidebar, 112 `px-page`, that 366
// and the 12px gap. At the 960px minimum window that is 214px against the 289px
// the labels need, and the toolbar is `justify-end`, so 55px of the action group
// painted over the filters. Nothing about a toolbar may cover a filter, so the
// group's left edge is the assertion, not the toolbar's.
//
// Only the ends are pinned. Where the labels switch over is a few pixels of
// filter-strip width away from here, and that width is whatever font the runner
// resolves — a narrower strip leaves the toolbar a wider box, and the labels are
// right to stay up in it. So these widths are chosen clear of the switch, and
// the classes' own numbers (289 and 214) come from measuring the shipped stack.
for (const viewport of [
  { width: 960, height: 600, labels: false },
  { width: 1000, height: 700, labels: false },
  { width: 1280, height: 800, labels: true }
]) {
  test(`the batch actions clear the filter strip at ${viewport.width}`, async ({ mount, page }) => {
    await page.setViewportSize(viewport)
    await mount(<AssetLibraryStory />)
    await batchModeControl(page).click()
    await expect(page.getByTestId('batch-toolbar')).toBeVisible()

    expect(await actionOverlap(page)).toBeLessThanOrEqual(0)
    // No room for them: the labels stand down rather than push the row over,
    // and the icon is what is left — a label-less, icon-less toolbar would fit
    // just as well, so the two states are asserted together.
    const labels = viewport.labels ? 'shown' : 'icon-only'
    const icons = viewport.labels ? 'hidden' : 'drawn'
    expect(await actionLabelStates(page)).toEqual([labels, labels, labels])
    expect(await actionIconStates(page)).toEqual([icons, icons, icons])
    if (!viewport.labels) {
      // The name is the hidden label, not something the icon replaced: a
      // `display: none` stand-down would leave the action unnamed.
      await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible()
    }
  })
}

// Chinese's labels need 214px of the toolbar's box and are left 247px — its
// filter strip is 33px narrower than English's, which is why the same window
// gives the two languages different boxes. So the compact state is per locale:
// a single threshold wide enough for English would take the labels away here,
// where they fit.
test('the batch actions keep their labels in Chinese at the minimum window', async ({
  mount,
  page
}) => {
  await page.setViewportSize({ width: 960, height: 600 })
  await mount(<AssetLibraryStory />)
  await page.evaluate(() => window.__assetLibraryTest?.setLanguage('zh-CN'))
  await batchModeControl(page).click()
  await expect(page.getByTestId('batch-toolbar')).toBeVisible()

  expect(await actionOverlap(page)).toBeLessThanOrEqual(0)
  expect(await actionLabelStates(page)).toEqual(['shown', 'shown', 'shown'])
})

// The tooltip is the only name an icon-only action has, and the state batch mode
// opens in is three disabled actions with nothing selected. A disabled `Button`
// carries `pointer-events-none`, so a trigger that is the button itself cannot
// see the hover that would open it. Playwright's own hover would jump the same
// gate, hence the raw pointer move.
test('an icon-only action still names itself on hover while it is unavailable', async ({
  mount,
  page
}) => {
  await page.setViewportSize({ width: 960, height: 600 })
  await mount(<AssetLibraryStory />)
  await batchModeControl(page).click()
  const action = page.getByRole('button', { name: 'Delete', exact: true })
  await expect(action).toBeDisabled()

  const box = await action.boundingBox()
  await page.mouse.move(
    (box?.x ?? 0) + (box?.width ?? 0) / 2,
    (box?.y ?? 0) + (box?.height ?? 0) / 2
  )
  await expect(page.getByRole('tooltip')).toHaveText('Delete')
})
