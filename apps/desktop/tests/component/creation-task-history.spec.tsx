import { expect, test, type Locator, type Page } from '@playwright/experimental-ct-react'
import { CreationWorkbenchRealShellStory } from './fixtures/creation-workbench-real-shell.story'
import type { ScriptedTask } from './fixtures/creation-workbench.story'

/**
 * Upward history pagination coverage (issue #195, ADR-0005): the production
 * Workbench page against the fixture's real keyset-cursor task endpoint —
 * newest 20 at entry, 20 more per near-top trigger past the old 50-task cap,
 * retryable failures, and refresh/history interleaving. Reading-anchor and
 * media-budget behavior over a fully paged-in history lives in
 * creation-workbench-scroll.spec.tsx.
 */

const scriptedSessionId = 'aaaaaaaa-0000-4000-8000-000000000001'

// Mixed succeeded/failed image/video tasks with distinct creation times,
// task N the newest — tall enough that 20 always overflow the workspace.
function mixedHistoryTasks(count: number, tag: string): ScriptedTask[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1
    const video = n % 2 === 0
    const failed = n % 5 === 0
    const portrait = n % 3 === 0
    const created = new Date(Date.UTC(2026, 7, 1, 0, n)).toISOString()
    return {
      id: `task-${tag}-${String(n).padStart(4, '0')}`,
      sessionId: scriptedSessionId,
      status: failed ? 'failed' : 'succeeded',
      mediaType: video ? 'video' : 'image',
      slotCount: 1,
      cancelRequested: false,
      terminalCause: null,
      createdAt: created,
      updatedAt: created,
      terminalAt: failed ? null : created,
      slots: [
        failed
          ? {
              index: 0,
              status: 'failed',
              failureReason: 'temporarily_unavailable',
              failureDiagnostic: {
                source: 'output_transfer',
                code: 'provider_output_http_status',
                message: `History diagnostic ${n}`,
                httpStatus: 403,
                providerType: 'image-provider',
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
      ]
    }
  })
}

async function selectFirstSession(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
}

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

async function userScrollTo(scroller: Locator, target: number | 'top' | 'bottom'): Promise<void> {
  await scroller.evaluate((element, requested) => {
    const top = requested === 'top' ? 0 : requested === 'bottom' ? element.scrollHeight : requested
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

// Pages history in through the real near-top trigger until `total` tasks are
// loaded; every iteration scrolls to the workspace top like a reader would.
async function pageHistoryIn(page: Page, scroller: Locator, total: number): Promise<void> {
  await expect
    .poll(
      async () => {
        await userScrollTo(scroller, 'top')
        return page.getByTestId('result-gallery').getAttribute('data-total-count')
      },
      { timeout: 30_000, interval: 150 }
    )
    .toBe(String(total))
}

test('entry shows the newest 20 at the bottom and upward paging passes 50 with no cap', async ({
  mount,
  page
}) => {
  const tasks = mixedHistoryTasks(65, 'entry')
  await mount(
    <CreationWorkbenchRealShellStory
      taskScript={{ tasks }}
      drafts={{ [scriptedSessionId]: null }}
    />
  )
  await selectFirstSession(page)
  const scroller = await settledScroller(page)

  // The first window is one 20-task page; the newest card sits nearest the
  // composer at the workspace bottom.
  const gallery = page.getByTestId('result-gallery')
  await expect(gallery).toHaveAttribute('data-total-count', '20')
  const newest = tasks[tasks.length - 1]
  await expect(page.getByTestId(`task-${newest.id}`)).toBeVisible()
  await expect
    .poll(async () =>
      scroller.evaluate(
        (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2
      )
    )
    .toBe(true)

  const pagesAtWindow = await page.evaluate(() => window.__creationDeckTest?.listTaskPages() ?? [])
  expect(pagesAtWindow).toHaveLength(1)
  expect(pagesAtWindow[0]).toEqual({ sessionId: scriptedSessionId, limit: 20, cursor: null })

  // Page the whole history in: 65 loaded, well past the old 50-task cap.
  await pageHistoryIn(page, scroller, tasks.length)
  await expect(gallery).toHaveAttribute('data-total-count', '65')

  const pages = await page.evaluate(() => window.__creationDeckTest?.listTaskPages() ?? [])
  expect(pages.length).toBe(4)
  // Each older page continues from the previous page's keyset cursor.
  for (let index = 1; index < pages.length; index += 1) {
    expect(pages[index].limit).toBe(20)
    expect(pages[index].cursor).toBeTruthy()
  }
  // The exhausted history states its end instead of offering more.
  await expect(page.getByTestId('task-history-end')).toBeVisible()

  // Bounded mounting survives the fully loaded history.
  const mountedCards = gallery.locator('section[data-testid^="task-"]')
  expect(await mountedCards.count()).toBeLessThan(20)
})

test('a failed older-page read keeps the loaded pages and retries through the notice', async ({
  mount,
  page
}) => {
  const tasks = mixedHistoryTasks(45, 'fail')
  await mount(
    <CreationWorkbenchRealShellStory
      taskScript={{ tasks }}
      drafts={{ [scriptedSessionId]: null }}
    />
  )
  await selectFirstSession(page)
  const scroller = await settledScroller(page)
  const gallery = page.getByTestId('result-gallery')
  await expect(gallery).toHaveAttribute('data-total-count', '20')

  await page.evaluate(() => {
    window.__creationDeckTest?.failListReads(1)
  })
  await userScrollTo(scroller, 'top')
  await expect(page.getByTestId('task-history-failed')).toBeVisible()
  await expect(gallery).toHaveAttribute('data-total-count', '20')
  const failedPageRequests = await page.evaluate(
    () => window.__creationDeckTest?.listTaskPages().length ?? 0
  )

  // The retry continues from the same cursor and lands the older page.
  await page.getByTestId('task-history-retry').click()
  await expect(page.getByTestId('task-history-failed')).toHaveCount(0)
  await expect(gallery).toHaveAttribute('data-total-count', '40')
  const retriedPages = await page.evaluate(() => window.__creationDeckTest?.listTaskPages() ?? [])
  expect(retriedPages.length).toBe(failedPageRequests + 1)
  expect(retriedPages[retriedPages.length - 1].cursor).toBeTruthy()
})

test('a new task while reading history keeps every loaded page and offers the light return hint', async ({
  mount,
  page
}) => {
  const tasks = mixedHistoryTasks(45, 'hint')
  await mount(
    <CreationWorkbenchRealShellStory
      taskScript={{ tasks }}
      drafts={{ [scriptedSessionId]: null }}
    />
  )
  await selectFirstSession(page)
  const scroller = await settledScroller(page)
  await pageHistoryIn(page, scroller, tasks.length)
  await userScrollTo(scroller, 'top')
  const oldest = tasks[0]
  await expect(page.getByTestId(`task-${oldest.id}`)).toBeVisible()

  const pushed: ScriptedTask = {
    ...mixedHistoryTasks(1, 'fresh')[0],
    createdAt: new Date(Date.UTC(2026, 7, 2, 0, 0)).toISOString()
  }
  await page.evaluate((task) => {
    window.__creationDeckTest?.pushTask(task as never)
  }, pushed as never)

  // The whole loaded history stays; the new task is only a light hint until
  // the creator explicitly returns to the bottom.
  const gallery = page.getByTestId('result-gallery')
  await expect(gallery).toHaveAttribute('data-total-count', '46')
  await expect(page.getByTestId(`task-${oldest.id}`)).toBeVisible()
  await expect(page.getByTestId('back-to-bottom')).toContainText('New task')

  await page.getByTestId('back-to-bottom').click()
  await expect(page.getByTestId(`task-${pushed.id}`)).toBeVisible()
  await expect
    .poll(async () =>
      scroller.evaluate(
        (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2
      )
    )
    .toBe(true)
})

test('a history intent arriving during an in-flight refresh continues after it', async ({
  mount,
  page
}) => {
  const tasks = mixedHistoryTasks(45, 'merge')
  await mount(
    <CreationWorkbenchRealShellStory
      taskScript={{ tasks }}
      drafts={{ [scriptedSessionId]: null }}
    />
  )
  await selectFirstSession(page)
  const scroller = await settledScroller(page)
  const gallery = page.getByTestId('result-gallery')
  await expect(gallery).toHaveAttribute('data-total-count', '20')

  // A refresh round is held in flight when the reader reaches the top: the
  // older-page intent must wait for it, then run — one round at a time.
  await page.evaluate(() => {
    window.__creationDeckTest?.holdNextListResponse()
    window.__creationDeckTest?.fireInvalidation()
  })
  await userScrollTo(scroller, 'top')
  await expect(page.getByTestId('task-history-loading')).toHaveCount(0)
  await page.evaluate(() => {
    window.__creationDeckTest?.releaseHeldListResponses()
  })

  await expect(gallery).toHaveAttribute('data-total-count', '40')
  const pages = await page.evaluate(() => window.__creationDeckTest?.listTaskPages() ?? [])
  expect(pages.length).toBe(3)
  expect(pages[1].cursor).toBe(null)
  expect(pages[2].cursor).toBeTruthy()
})

async function visibleAnchor(
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

async function cardOffsetFromScroller(card: Locator, scroller: Locator): Promise<number> {
  const [cardBox, scrollBox] = await Promise.all([card.boundingBox(), scroller.boundingBox()])
  return (cardBox?.y ?? 0) - (scrollBox?.y ?? 0)
}

test('inserting an older page above keeps the reading anchor in place', async ({ mount, page }) => {
  const tasks = mixedHistoryTasks(45, 'anchor')
  await mount(
    <CreationWorkbenchRealShellStory
      taskScript={{ tasks }}
      drafts={{ [scriptedSessionId]: null }}
    />
  )
  await selectFirstSession(page)
  const scroller = await settledScroller(page)
  const gallery = page.getByTestId('result-gallery')
  await expect(gallery).toHaveAttribute('data-total-count', '20')

  // Hold the older page so the anchor is captured immediately before the
  // insertion, then release: the visible card must keep its viewport offset.
  await page.evaluate(() => {
    window.__creationDeckTest?.holdNextListResponse()
  })
  await userScrollTo(scroller, 'top')
  await expect(page.getByTestId('task-history-loading')).toBeVisible()
  const anchor = await visibleAnchor(page)
  const anchorCard = page.getByTestId(anchor.testId)

  await page.evaluate(() => {
    window.__creationDeckTest?.releaseHeldListResponses()
  })
  await expect(gallery).toHaveAttribute('data-total-count', '40')
  await expect(anchorCard).toBeVisible()
  await expect
    .poll(async () => Math.abs((await cardOffsetFromScroller(anchorCard, scroller)) - anchor.top))
    .toBeLessThanOrEqual(1)
})
