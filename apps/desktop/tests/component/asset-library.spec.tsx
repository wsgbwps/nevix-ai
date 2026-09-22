import { expect, test } from '@playwright/experimental-ct-react'
import type { Locator } from '@playwright/test'
import { AssetLibraryStory } from './fixtures/asset-library.story'

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

test('wall previews only bounded image candidates and never fetches video originals', async ({
  mount,
  page
}) => {
  await mount(<AssetLibraryStory />)
  await expect
    .poll(() => page.evaluate(() => window.__assetLibraryTest?.previewCalls()))
    .toEqual(['asset-one', 'asset-three'])
})

test('wall preview loading is capped at four concurrent image bodies', async ({ mount, page }) => {
  await mount(<AssetLibraryStory deferredPreviews />)
  await expect
    .poll(() => page.evaluate(() => window.__assetLibraryTest?.maxActivePreviews()))
    .toBe(4)
  expect(await page.evaluate(() => window.__assetLibraryTest?.previewCalls().length)).toBe(4)
  await page.evaluate(() => window.__assetLibraryTest?.releasePreviews())
  await expect
    .poll(() => page.evaluate(() => window.__assetLibraryTest?.previewCalls().length))
    .toBe(8)
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
// row is 38px (32px buttons in a 1px border and 2px padding), and at the
// minimum window the row is also 848px wide against a 366px filter bar plus a
// 519px toolbar — so the header has both a height and a width it must not
// grow past here. The wall below is `flex-1` in that column, which is what
// turns either growth into a 6px or 44px jump under the pointer.
for (const viewport of [
  { width: 960, height: 600 },
  { width: 1280, height: 800 }
]) {
  test(`entering batch mode leaves the wall where it was at ${viewport.width}`, async ({
    mount,
    page
  }) => {
    await page.setViewportSize(viewport)
    await mount(<AssetLibraryStory />)
    const wall = page.getByTestId('asset-library').locator('> div').nth(1)
    const card = page.getByTestId('asset-card').first()
    await expect(card).toBeVisible()

    const top = async (locator: Locator): Promise<number> =>
      (await locator.boundingBox())?.y ?? Number.NaN
    const before = { wall: await top(wall), card: await top(card) }

    await page.getByRole('button', { name: 'Batch actions' }).click()
    await expect(page.getByTestId('batch-toolbar')).toBeVisible()

    expect({
      wall: (await top(wall)) - before.wall,
      card: (await top(card)) - before.card
    }).toEqual({ wall: 0, card: 0 })
  })
}
