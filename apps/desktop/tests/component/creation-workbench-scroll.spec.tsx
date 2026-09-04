import { expect, test } from '@playwright/experimental-ct-react'
import type { Locator, Page } from '@playwright/test'
import { CreationWorkbenchRealShellStory } from './fixtures/creation-workbench-real-shell.story'
import type { CreationSessionView } from '../src/renderer/src/features/creation/api/go-creation-http'
import type { ScriptedTask } from './fixtures/creation-workbench.story'

// Scroll-contract tests for the Creation Workbench inside the App Shell.
// This spec deliberately lives apart from creation-workbench.spec.tsx: its
// story imports the real stylesheet, and Playwright CT loads a spec module's
// whole import graph for every test in the file — keeping the CSS import in
// a dedicated story file is what leaves the other specs' CSS-less geometry
// untouched.

const scriptedSessionId = 'aaaaaaaa-0000-4000-8000-000000000001'

// Three tall succeeded tasks under one session — enough gallery height to
// overflow the workspace scroller. Shared by the scroll and presence specs.
function tallImageTasks(tag: string): ScriptedTask[] {
  return [1, 2, 3].map((n) => ({
    id: `dddddddd-0000-4000-8000-0000000${tag}${String(n).padStart(2, '0')}`,
    sessionId: scriptedSessionId,
    status: 'succeeded',
    mediaType: 'image',
    slotCount: 1,
    cancelRequested: false,
    terminalCause: null,
    createdAt: `2026-08-2${n}T09:00:00Z`,
    updatedAt: `2026-08-2${n}T09:01:00Z`,
    terminalAt: `2026-08-2${n}T09:01:00Z`,
    slots: [
      {
        index: 0,
        status: 'succeeded',
        failureReason: null,
        result: {
          mimeType: 'image/jpeg',
          byteSize: 2048,
          checksumSha256: 'ab'.repeat(32),
          widthPx: 1568,
          heightPx: 672,
          durationMs: null
        }
      }
    ]
  }))
}

// The scroller the presence specs drive, once the mount-time reveal settled.
async function settledScroller(page: Page): Promise<Locator> {
  const scroller = page.getByTestId('creation-workbench').getByRole('main').locator('div').first()
  await expect
    .poll(
      async () =>
        scroller.evaluate((el) => el.scrollTop > 0 || el.scrollHeight <= el.clientHeight + 1),
      { timeout: 5_000 }
    )
    .toBe(true)
  return scroller
}

test('workspace and session-list scrolling stay independent in the shell', async ({
  mount,
  page
}) => {
  // Regression for the coupled-scrolling report: with tall gallery content,
  // wheel-scrolling the workspace also scrolled the session list (and vice
  // versa) — the shell's min-h-svh-only wrapper gave the layout no definite
  // viewport height, so both `overflow-y-auto` regions rendered at content
  // height and the wheel chained to the document, scrolling the whole shell
  // as one block. The gallery must scroll inside the workspace scroller and
  // the session list inside its own, with neither moving the other.
  const tallTasks = tallImageTasks('scroll')
  // Enough rows for the session list to overflow its own column too; the
  // first row keeps the scripted draft/tasks session for the selection below.
  const sessions: CreationSessionView[] = [
    {
      id: scriptedSessionId,
      name: 'Spring campaign',
      createdAt: '2026-08-20T10:00:00Z',
      updatedAt: '2026-08-21T10:00:00Z'
    },
    ...Array.from({ length: 14 }, (_, i) => ({
      id: `bbbbbbbb-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      name: `List row ${i + 1}`,
      createdAt: '2026-08-22T10:00:00Z',
      updatedAt: '2026-08-22T10:00:00Z'
    }))
  ]
  await mount(
    <CreationWorkbenchRealShellStory sessions={sessions} taskScript={{ tasks: tallTasks }} />
  )
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
  await expect(page.getByTestId('composer')).toBeVisible()

  const workbench = page.getByTestId('creation-workbench')
  const workspace = workbench.getByRole('main')
  // Before the coupled-scroll fix the scroller trivially had no overflow; the
  // settle poll proves it really reaches the bottom once its height is bound.
  const scroller = await settledScroller(page)
  // Start from the top of the gallery so a downward wheel has room to scroll.
  await scroller.evaluate((el) => el.scrollTo({ top: 0 }))

  // Wheel inside the workspace: the gallery must move, the session list must
  // stay exactly where it is.
  const list = page.getByTestId('session-list')
  const listTopBefore = (await list.boundingBox())!
  const galleryTopBefore = (await page.getByTestId('result-gallery').boundingBox())!
  const workspaceBox = (await workspace.boundingBox())!
  // Wheel default actions land on a later compositor frame, so the resulting
  // movement is awaited by polling instead of being measured immediately.
  await page.mouse.move(workspaceBox.x + workspaceBox.width * 0.6, workspaceBox.y + 120)
  await page.mouse.wheel(0, 400)
  await expect
    .poll(async () => (await page.getByTestId('result-gallery').boundingBox())?.y ?? -1, {
      timeout: 2_000
    })
    .toBeLessThan(galleryTopBefore.y)
  const listTopAfter = (await list.boundingBox())!
  expect(listTopAfter.y).toBeCloseTo(listTopBefore.y, 0)

  // Wheel inside the session list: the list must scroll in its own column and
  // the workspace must stay exactly where it is. The workspace wheel above
  // lands at the bottom, where the expanding composer's bottom-reserve keeps
  // bumping scrollTop while its spring settles — that tracking is intended,
  // so wait for it to go still before the exact-position comparison.
  await expect
    .poll(
      async () => {
        const a = await scroller.evaluate((el) => el.scrollTop)
        await page.waitForTimeout(120)
        return (await scroller.evaluate((el) => el.scrollTop)) - a
      },
      { timeout: 5_000 }
    )
    .toBe(0)
  const heading = page.getByRole('heading', { name: 'Spring campaign', exact: true })
  const headingTopBefore = (await heading.boundingBox())!
  const asideBox = (await workbench.getByRole('complementary').boundingBox())!
  await page.mouse.move(asideBox.x + asideBox.width / 2, asideBox.y + 200)
  await page.mouse.wheel(0, 300)
  await expect
    .poll(
      async () =>
        (await list.evaluate((ul) => (ul.parentElement as HTMLElement).scrollTop)) > 0 ||
        (await heading.boundingBox())!.y !== headingTopBefore.y,
      { timeout: 2_000 }
    )
    .toBe(true)
  const headingTopAfter = (await heading.boundingBox())!
  expect(headingTopAfter.y).toBeCloseTo(headingTopBefore.y, 0)
  const listScrollTop = await list.evaluate((ul) => (ul.parentElement as HTMLElement).scrollTop)
  expect(listScrollTop).toBeGreaterThan(0)
})

test('the composer collapses away from the bottom and re-expands at the bottom or on focus', async ({
  mount,
  page
}) => {
  // Presence contract (完整态/紧凑态): the composer is expanded while the
  // workspace scroller sits at the bottom, collapses to the compact form on
  // scrolling away, and clicking the prompt area pins the expanded form until
  // the next scroll — blur alone must not collapse it. The pill anchors to
  // the composer container's top-right corner in both states.
  await mount(<CreationWorkbenchRealShellStory taskScript={{ tasks: tallImageTasks('fold') }} />)
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
  await expect(page.getByTestId('composer')).toBeVisible()

  const scroller = await settledScroller(page)

  const params = page.getByTestId('composer-params')
  const composer = page.getByTestId('composer')
  await expect(params).toBeVisible()
  const expandedBox = (await composer.boundingBox())!
  const expandedStripHeight = (await page.getByTestId('deck-strip').boundingBox())!.height
  // The expanded prompt is the taller three-line field, and the scroller's
  // measured bottom reserve clears the composer's full height plus its
  // bottom inset — the last task card never sits underneath at the bottom.
  expect((await page.getByTestId('composer-prompt').boundingBox())!.height).toBeGreaterThan(90)
  const reservePx = await scroller.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom))
  expect(reservePx).toBeGreaterThanOrEqual(expandedBox.height + 20)

  // Scrolling away collapses the form overall — narrower centered bar, lower
  // height — with capability controls hidden, the submit circle reachable,
  // and the pill above the composer's top-right corner. A bound pile scales
  // down proportionally instead of holding the row tall.
  await scroller.evaluate((el) => el.scrollTo({ top: 0 }))
  await expect(params).toBeHidden()
  const compactBox = (await composer.boundingBox())!
  expect(compactBox.height).toBeLessThan(expandedBox.height - 40)
  expect(compactBox.width).toBeLessThan(expandedBox.width - 200)
  const compactStripHeight = (await page.getByTestId('deck-strip').boundingBox())!.height
  expect(compactStripHeight).toBeLessThan(expandedStripHeight - 12)
  await expect(page.getByTestId('composer-submit')).toBeVisible()
  const pill = page.getByTestId('back-to-bottom')
  await expect(pill).toBeVisible()
  const pillBox = (await pill.boundingBox())!
  const composerBox = (await composer.boundingBox())!
  expect(pillBox.y + pillBox.height).toBeLessThanOrEqual(composerBox.y + 1)
  expect(pillBox.x + pillBox.width).toBeCloseTo(composerBox.x + composerBox.width, 0)

  // While compact, the pile still fans out on hover — at the scaled-down
  // pitch, without expanding the whole composer. The newest card extends;
  // the oldest anchors the fan's left.
  const strip = page.getByTestId('deck-strip')
  const stripBox = (await strip.boundingBox())!
  const underCard = strip.locator('[role="listitem"]').last()
  await page.mouse.move(stripBox.x + 8, stripBox.y + 8)
  await expect
    .poll(async () => (await underCard.boundingBox())?.x ?? -1)
    .toBeGreaterThan(stripBox.x + 15)
  await page.mouse.move(0, 0)
  await expect
    .poll(async () => (await underCard.boundingBox())?.x ?? -1)
    .toBeLessThan(stripBox.x + 15)

  // Clicking the prompt area expands, focuses it, and the next scroll —
  // focus still held — collapses again. The pill stays anchored to the
  // composer's top-right corner in the pinned expanded form too.
  await page.getByTestId('composer-prompt').click()
  await expect(params).toBeVisible()
  await expect(page.getByTestId('composer-prompt')).toBeFocused()
  await page.waitForTimeout(400)
  const pinnedPillBox = (await pill.boundingBox())!
  const pinnedComposerBox = (await composer.boundingBox())!
  expect(pinnedPillBox.y + pinnedPillBox.height).toBeLessThanOrEqual(pinnedComposerBox.y + 1)
  expect(pinnedPillBox.x + pinnedPillBox.width).toBeCloseTo(
    pinnedComposerBox.x + pinnedComposerBox.width,
    0
  )
  await scroller.evaluate((el) => el.scrollTo({ top: 40 }))
  await expect(params).toBeHidden()

  // Blur alone never collapses: the expanded form survives losing focus
  // without a scroll.
  await page.getByTestId('composer-prompt').click()
  await expect(params).toBeVisible()
  await page.getByTestId('composer-prompt').evaluate((el) => (el as HTMLTextAreaElement).blur())
  await expect(params).toBeVisible()

  // Reaching the bottom restores the full form.
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
  await expect(params).toBeVisible()

  // From the compact form, the deck's add entry still opens the material
  // picker — and expands the composer with it. The press releases well after
  // the pin's spring moved the entry, so the picker must be anchored at
  // pointerdown, not at the release-time click.
  await scroller.evaluate((el) => el.scrollTo({ top: 0 }))
  await expect(params).toBeHidden()
  const addEntry = page.getByRole('button', { name: 'Add reference material', exact: true })
  await addEntry.hover()
  const chooserPromise = page.waitForEvent('filechooser')
  await page.mouse.down()
  await page.waitForTimeout(150)
  await page.mouse.up()
  await chooserPromise
  await expect(params).toBeVisible()
})

test('the compact form also shrinks the empty deck add tile', async ({ mount, page }) => {
  // 整体收缩 with an empty deck: the centered bar narrows and shortens, and
  // the deck's add tile drops from the 64px expanded tile into the compact
  // single row instead of keeping the expanded row tall.
  await mount(
    <CreationWorkbenchRealShellStory
      drafts={{ [scriptedSessionId]: null }}
      taskScript={{ tasks: tallImageTasks('slim') }}
    />
  )
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
  await expect(page.getByTestId('composer')).toBeVisible()

  const scroller = await settledScroller(page)
  const composer = page.getByTestId('composer')
  const tile = page.getByRole('button', { name: 'Add reference material', exact: true })
  const expandedBox = (await composer.boundingBox())!
  const expandedTileHeight = (await tile.boundingBox())!.height

  await scroller.evaluate((el) => el.scrollTo({ top: 0 }))
  await expect(page.getByTestId('composer-params')).toBeHidden()

  const compactBox = (await composer.boundingBox())!
  expect(compactBox.width).toBeLessThan(expandedBox.width - 200)
  // The empty-deck compact bar sheds the whole expanded main-row height, not
  // just the control row: with the tile down at 40px the card loses ~64px.
  expect(compactBox.height).toBeLessThan(expandedBox.height - 40)
  const compactTileHeight = (await tile.boundingBox())!.height
  expect(compactTileHeight).toBeLessThan(expandedTileHeight - 12)
})
