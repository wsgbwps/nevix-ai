import { expect, test } from '@playwright/experimental-ct-react'
import type { Locator, Page } from '@playwright/test'
import { CreationWorkbenchRealShellStory } from './fixtures/creation-workbench-real-shell.story'
import type {
  CreationSessionView,
  ReferenceMaterialView
} from '../src/renderer/src/features/creation/api/go-creation-http'
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

function materialId(tag: string, n: number): string {
  return `material-${tag}-${String(n).padStart(4, '0')}`
}

function manyMixedTasks(count: number, tag: string, withReferences = false): ScriptedTask[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1
    const video = n % 2 === 0
    const failed = n % 5 === 0
    const portrait = n % 3 === 0
    return {
      id: `task-${tag}-${String(n).padStart(4, '0')}`,
      sessionId: scriptedSessionId,
      status: failed ? 'failed' : 'succeeded',
      mediaType: video ? 'video' : 'image',
      slotCount: 1,
      cancelRequested: false,
      terminalCause: null,
      createdAt: new Date(Date.UTC(2026, 7, 1, 0, n)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 7, 1, 0, n, 1)).toISOString(),
      terminalAt: new Date(Date.UTC(2026, 7, 1, 0, n, 1)).toISOString(),
      slots: [
        failed
          ? {
              index: 0,
              status: 'failed',
              failureReason: 'temporarily_unavailable',
              failureDiagnostic: {
                source: 'output_transfer',
                code: 'provider_output_http_status',
                message: `Mixed-media diagnostic ${n}: provider output download returned HTTP 403`,
                httpStatus: 403,
                providerType: video ? 'video-provider' : 'image-provider',
                requestId: `request-${n}`
              },
              result: null
            }
          : {
              index: 0,
              status: 'succeeded',
              failureReason: null,
              result: {
                mimeType: video ? 'video/mp4' : 'image/jpeg',
                byteSize: 2048,
                checksumSha256: 'ab'.repeat(32),
                widthPx: portrait ? 800 : 1568,
                heightPx: portrait ? 1424 : 672,
                durationMs: video ? 5_000 : null
              }
            }
      ],
      specification: {
        prompt: `Mixed ${video ? 'video' : 'image'} task ${n}${n % 3 === 0 ? ' with a longer responsive prompt that wraps onto another line' : ''}`,
        model: video ? 'doubao-seedance-2-5' : 'doubao-seedream-5.0-pro',
        mode: video ? 'text-to-video' : 'text-to-image',
        ratio: portrait ? '9:16' : '21:9',
        resolution: video ? '720p' : '2K',
        quantity: 1,
        durationSeconds: video ? 5 : null,
        references: withReferences
          ? [
              {
                materialId: materialId(tag, n),
                role: 'reference',
                kind: 'image'
              }
            ]
          : []
      }
    }
  })
}

function referencedMaterials(count: number, tag: string): ReferenceMaterialView[] {
  return Array.from({ length: count }, (_, index) => ({
    id: materialId(tag, index + 1),
    kind: 'image',
    fileName: `reference-${index + 1}.png`,
    mimeType: 'image/png',
    byteSize: 4 * 1024 * 1024,
    widthPx: 1568,
    heightPx: 672,
    pixelCount: 1568 * 672,
    durationMs: null,
    checksumSha256: 'cd'.repeat(32),
    claimsVersion: 1,
    createdAt: '2026-08-01T00:00:00Z'
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

async function visibleTaskAnchor(
  page: Page
): Promise<{ readonly testId: string; readonly top: number }> {
  let anchor: { readonly testId: string; readonly top: number } | null = null
  await expect
    .poll(async () => {
      anchor = await page.evaluate(() => {
        const scroller = document
          .querySelector('[data-testid="creation-workbench"] main')
          ?.querySelector('div')
        if (!(scroller instanceof HTMLElement)) return null
        const viewport = scroller.getBoundingClientRect()
        const card = [
          ...document.querySelectorAll<HTMLElement>('section[data-testid^="task-"]')
        ].find((candidate) => {
          const rect = candidate.getBoundingClientRect()
          return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1
        })
        if (card === undefined) return null
        return {
          testId: card.dataset.testid ?? '',
          top: card.getBoundingClientRect().top - viewport.top
        }
      })
      return anchor
    })
    .not.toBeNull()
  return anchor!
}

async function taskOffsetFromScroller(card: Locator, scroller: Locator): Promise<number> {
  const [cardBox, scrollBox] = await Promise.all([card.boundingBox(), scroller.boundingBox()])
  return (cardBox?.y ?? 0) - (scrollBox?.y ?? 0)
}

async function userScrollTo(
  scroller: Locator,
  target: number | 'top' | 'bottom' | { readonly fraction: number }
): Promise<void> {
  await scroller.evaluate((element, requested) => {
    const top =
      requested === 'top'
        ? 0
        : requested === 'bottom'
          ? element.scrollHeight
          : typeof requested === 'number'
            ? requested
            : element.scrollHeight * requested.fraction
    element.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: top < element.scrollTop ? -1 : 1
      })
    )
    element.scrollTo({ top })
  }, target)
}

test('the initial bottom follow survives a delayed virtualizer correction', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchRealShellStory taskScript={{ tasks: tallImageTasks('settle') }} />)
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
  const scroller = await settledScroller(page)
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2
      )
    )
    .toBe(true)

  // A delayed size correction is programmatic, not reading intent. Initial
  // bottom-follow remains responsible until an explicit user input takes over.
  await scroller.evaluate((element) => element.scrollTo({ top: 0 }))
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2
      )
    )
    .toBe(true)
  await expect(page.getByTestId('back-to-bottom')).toHaveCount(0)
})

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
  // Before the coupled-scroll fix the scroller trivially had no overflow; the
  // settle poll proves it really reaches the bottom once its height is bound.
  const scroller = await settledScroller(page)
  // Start from the top of the gallery so a downward wheel has room to scroll.
  await userScrollTo(scroller, 'top')

  // Wheel inside the workspace: the gallery must move, the session list must
  // stay exactly where it is.
  const list = page.getByTestId('session-list')
  const gallery = page.getByTestId('result-gallery')
  const listTopBefore = (await list.boundingBox())!
  const galleryTopBefore = (await gallery.boundingBox())!
  // Wheel default actions land on a later compositor frame, so the resulting
  // movement is awaited by polling instead of being measured immediately.
  await gallery.hover({ position: { x: galleryTopBefore.width * 0.6, y: 20 } })
  await page.mouse.wheel(0, 400)
  await expect
    .poll(async () => (await gallery.boundingBox())?.y ?? -1, {
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

test('a large task history mounts and loads media only around the visible window', async ({
  mount,
  page
}) => {
  const tasks = manyMixedTasks(120, 'window', true)
  await mount(
    <CreationWorkbenchRealShellStory
      taskScript={{ tasks }}
      drafts={{ [scriptedSessionId]: null }}
      materials={{ [scriptedSessionId]: referencedMaterials(tasks.length, 'window') }}
    />
  )
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()

  const scroller = await settledScroller(page)
  const gallery = page.getByTestId('result-gallery')
  await expect(gallery).toHaveAttribute('data-total-count', String(tasks.length))

  const mountedCards = gallery.locator('section[data-testid^="task-"]')
  await expect.poll(() => mountedCards.count()).toBeGreaterThan(0)
  expect(await mountedCards.count()).toBeLessThan(20)
  await expect
    .poll(async () =>
      page.evaluate(() => window.__creationDeckTest?.resultBlobTransfers().length ?? 0)
    )
    .toBeGreaterThan(0)
  expect(
    await page.evaluate(() => window.__creationDeckTest?.resultBlobTransfers().length ?? 0)
  ).toBeLessThan(20)
  await expect
    .poll(async () =>
      page.evaluate(() => window.__creationDeckTest?.materialBlobCalls().length ?? 0)
    )
    .toBeGreaterThan(0)
  const bottomThumbnailLoads = await page.evaluate(
    () => window.__creationDeckTest?.materialBlobCalls().length ?? 0
  )
  expect(bottomThumbnailLoads).toBeLessThan(20)

  await userScrollTo(scroller, 'top')
  await expect
    .poll(async () => (await mountedCards.first().getAttribute('data-testid')) ?? '')
    .not.toBe('')
  expect(await mountedCards.count()).toBeLessThan(20)
  await expect
    .poll(async () =>
      page.evaluate(() => window.__creationDeckTest?.materialBlobCalls().length ?? 0)
    )
    .toBeGreaterThan(bottomThumbnailLoads)
  const afterTopThumbnailLoads = await page.evaluate(
    () => window.__creationDeckTest?.materialBlobCalls().length ?? 0
  )

  // Returning to the first window must reacquire its thumbnails: rows that
  // retired at the top released their display URLs instead of accumulating.
  await userScrollTo(scroller, 'bottom')
  await expect
    .poll(async () =>
      page.evaluate(() => window.__creationDeckTest?.materialBlobCalls().length ?? 0)
    )
    .toBeGreaterThan(afterTopThumbnailLoads)
})

test('a new task follows at the bottom but preserves an older reading position', async ({
  mount,
  page
}) => {
  const tasks = manyMixedTasks(40, 'follow')
  await mount(<CreationWorkbenchRealShellStory taskScript={{ tasks }} />)
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
  const scroller = await settledScroller(page)

  const followed = manyMixedTasks(1, 'bottom')[0]
  await page.evaluate((task) => window.__creationDeckTest?.pushTask(task as never), followed)
  await expect(page.getByTestId(`task-${followed.id}`)).toBeVisible()
  await expect
    .poll(async () =>
      scroller.evaluate(
        (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2
      )
    )
    .toBe(true)

  await userScrollTo(scroller, { fraction: 1 / 3 })
  await expect(page.getByTestId('back-to-bottom')).toBeVisible()
  // The anchor contract begins after the creator's scroll has settled; an
  // in-flight user scroll legitimately still owns the viewport position.
  await page.waitForTimeout(200)
  const anchor = await visibleTaskAnchor(page)
  const pushed = manyMixedTasks(1, 'new')[0]
  await page.evaluate((task) => window.__creationDeckTest?.pushTask(task as never), pushed)

  await expect(page.getByTestId('result-gallery')).toHaveAttribute(
    'data-total-count',
    String(tasks.length + 2)
  )
  await expect(page.getByTestId('back-to-bottom')).toContainText('New task')
  const anchorCard = page.getByTestId(anchor.testId)
  await expect(anchorCard).toBeVisible()
  // Chromium can round the transform and the scroll offset to opposite device
  // pixels while a newly measured virtual row settles.
  await expect
    .poll(async () => Math.abs((await taskOffsetFromScroller(anchorCard, scroller)) - anchor.top))
    .toBeLessThanOrEqual(1)

  await page.getByTestId('back-to-bottom').click()
  await expect(page.getByTestId(`task-${pushed.id}`)).toBeVisible()
  await expect
    .poll(async () =>
      scroller.evaluate(
        (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2
      )
    )
    .toBe(true)

  // Native scrollbar drags have no wheel/key/touch event. Its pointer
  // lifecycle still counts as an explicit return and restores following.
  await userScrollTo(scroller, { fraction: 1 / 3 })
  await expect(page.getByTestId('back-to-bottom')).toBeVisible()
  await scroller.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    element.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        buttons: 1,
        clientX: bounds.right - 1,
        clientY: bounds.top + bounds.height / 2,
        pointerId: 1
      })
    )
    element.scrollTo({ top: element.scrollHeight })
  })
  await expect(page.getByTestId('back-to-bottom')).toHaveCount(0)
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
  })
  const afterScrollbar = manyMixedTasks(1, 'scrollbar')[0]
  await page.evaluate((task) => window.__creationDeckTest?.pushTask(task as never), afterScrollbar)
  await expect(page.getByTestId(`task-${afterScrollbar.id}`)).toBeVisible()
  await expect
    .poll(async () =>
      scroller.evaluate(
        (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2
      )
    )
    .toBe(true)
})

test('detail and responsive height changes keep the visible task anchor stable', async ({
  mount,
  page
}) => {
  await page.setViewportSize({ width: 1200, height: 720 })
  const tasks = manyMixedTasks(60, 'anchor')
  await mount(<CreationWorkbenchRealShellStory taskScript={{ tasks, taskDetailsDeferred: true }} />)
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
  const scroller = await settledScroller(page)
  await userScrollTo(scroller, { fraction: 1 / 2 })
  // Let the virtualizer finish the creator's upward scroll before treating
  // the visible task as the stable reading anchor.
  await page.waitForTimeout(200)
  const anchor = await visibleTaskAnchor(page)
  const anchorCard = page.getByTestId(anchor.testId)

  await page.evaluate(() => window.__creationDeckTest?.releaseTaskDetails())
  const taskId = anchor.testId.slice('task-'.length)
  await expect(page.getByTestId(`slot-${taskId}-0`)).toHaveAttribute(
    'data-slot-status',
    /^(succeeded|failed)$/
  )
  await expect(page.locator('[data-testid^="slot-diagnostic-"]').first()).toBeVisible()
  await expect.poll(() => taskOffsetFromScroller(anchorCard, scroller)).toBeCloseTo(anchor.top, 0)

  const beforeResize = await taskOffsetFromScroller(anchorCard, scroller)
  await page.setViewportSize({ width: 740, height: 720 })
  await expect(anchorCard).toBeVisible()
  await expect.poll(() => taskOffsetFromScroller(anchorCard, scroller)).toBeCloseTo(beforeResize, 0)

  const beforeComposerExpansion = await taskOffsetFromScroller(anchorCard, scroller)
  await page.getByTestId('composer-prompt').click()
  await expect(page.getByTestId('composer-params')).toBeVisible()
  await expect
    .poll(() => taskOffsetFromScroller(anchorCard, scroller))
    .toBeCloseTo(beforeComposerExpansion, 0)
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
  await userScrollTo(scroller, 'top')
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
  await userScrollTo(scroller, 40)
  await expect(params).toBeHidden()

  // Blur alone never collapses: the expanded form survives losing focus
  // without a scroll.
  await page.getByTestId('composer-prompt').click()
  await expect(params).toBeVisible()
  await page.getByTestId('composer-prompt').evaluate((el) => (el as HTMLTextAreaElement).blur())
  await expect(params).toBeVisible()

  // Reaching the bottom restores the full form.
  await userScrollTo(scroller, 'bottom')
  await expect(params).toBeVisible()

  // From the compact form, the deck's add entry still opens the material
  // picker — and expands the composer with it. The press releases well after
  // the pin's spring moved the entry, so the picker must be anchored at
  // pointerdown, not at the release-time click.
  await userScrollTo(scroller, 'top')
  await expect(params).toBeHidden()
  const addEntry = page.getByRole('button', { name: 'Add reference material', exact: true })
  const chooserPromise = page.waitForEvent('filechooser')
  await addEntry.click({ delay: 150 })
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

  await userScrollTo(scroller, 'top')
  await expect(page.getByTestId('composer-params')).toBeHidden()

  const compactBox = (await composer.boundingBox())!
  expect(compactBox.width).toBeLessThan(expandedBox.width - 200)
  // The empty-deck compact bar sheds the whole expanded main-row height, not
  // just the control row: with the tile down at 40px the card loses ~64px.
  expect(compactBox.height).toBeLessThan(expandedBox.height - 40)
  const compactTileHeight = (await tile.boundingBox())!.height
  expect(compactTileHeight).toBeLessThan(expandedTileHeight - 12)
})
