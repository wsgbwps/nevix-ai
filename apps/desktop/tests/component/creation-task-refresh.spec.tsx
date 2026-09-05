import { expect, test, type Page } from '@playwright/experimental-ct-react'
import { CreationWorkbenchStory, type ScriptedTask } from './fixtures/creation-workbench.story'

/**
 * Refresh-module component coverage (issue #191, ADR-0005): the production
 * Workbench page driven through its scripted ports. Scheduling invariants
 * with a controlled clock live in tests/unit/creation-task-refresh.test.mts;
 * these tests pin the user-visible behavior — merged rounds, stale markers,
 * per-entry eligibility, and the fallback poll — through the real page.
 */

// The scripted session id the fixture mounts by default.
const sessionAId = 'aaaaaaaa-0000-4000-8000-000000000001'

function runningTask(id: string, updatedAt: string): ScriptedTask {
  return {
    id,
    sessionId: sessionAId,
    status: 'processing',
    mediaType: 'image',
    slotCount: 1,
    cancelRequested: false,
    terminalCause: null,
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt,
    terminalAt: null,
    slots: [{ index: 0, status: 'generating', failureReason: null, result: null }]
  }
}

function settledTask(id: string, updatedAt: string): ScriptedTask {
  return {
    ...runningTask(id, updatedAt),
    status: 'succeeded',
    terminalAt: updatedAt,
    slots: [{ index: 0, status: 'succeeded', failureReason: null, result: null }]
  }
}

async function selectFirstSession(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
  await expect(page.getByTestId('composer')).toBeVisible()
}

function listTasksCalls(page: Page): Promise<number> {
  return page.evaluate(() => window.__creationDeckTest?.listTasksCalls() ?? 0)
}

test('consecutive SSE invalidations coalesce into one read round', async ({ mount, page }) => {
  const first = runningTask('dddddddd-0000-4000-8000-00000000c001', '2026-09-01T09:00:01Z')
  const second = runningTask('dddddddd-0000-4000-8000-00000000c002', '2026-09-01T09:00:02Z')
  await mount(<CreationWorkbenchStory taskScript={{ tasks: [first] }} />)
  await selectFirstSession(page)
  await expect(page.getByTestId(`task-${first.id}`)).toBeVisible()
  const callsAfterEntry = await listTasksCalls(page)

  // One commit, then two notifications inside the same tick: one merged round.
  await page.evaluate((task) => {
    const controls = window.__creationDeckTest
    controls?.pushTask(task as never)
    controls?.fireInvalidation()
  }, second as never)
  await expect(page.getByTestId(`task-${second.id}`)).toBeVisible()
  expect(await listTasksCalls(page)).toBe(callsAfterEntry + 1)
})

test('a failed detail read keeps the last consistent card and marks it unrefreshed', async ({
  mount,
  page
}) => {
  const task = runningTask('dddddddd-0000-4000-8000-00000000d001', '2026-09-01T09:00:01Z')
  await mount(<CreationWorkbenchStory taskScript={{ tasks: [task] }} />)
  await selectFirstSession(page)
  await expect(page.getByTestId(`slot-${task.id}-0`)).toHaveAttribute(
    'data-slot-status',
    'generating'
  )

  // The task settled on the server, but its detail read fails: the card keeps
  // the last consistent copy and says so.
  const settled = settledTask(task.id, '2026-09-01T09:00:09Z')
  await page.evaluate((updated) => {
    window.__creationDeckTest?.failDetailReads((updated as { id: string }).id, 1)
    window.__creationDeckTest?.updateTask(updated as never)
  }, settled as never)
  await expect(page.getByTestId(`task-detail-stale-${task.id}`)).toBeVisible()
  await expect(page.getByTestId(`slot-${task.id}-0`)).toHaveAttribute(
    'data-slot-status',
    'generating'
  )

  // The next round retries the failed detail and clears the marker.
  await page.evaluate(() => {
    window.__creationDeckTest?.fireInvalidation()
  })
  await expect(page.getByTestId(`task-detail-stale-${task.id}`)).toHaveCount(0)
  await expect(page.getByTestId(`slot-${task.id}-0`)).toHaveAttribute(
    'data-slot-status',
    'succeeded'
  )
})

test('a new task whose detail fails shows placeholders marked unrefreshed, not the empty state', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory taskScript={{ tasks: [] }} />)
  await selectFirstSession(page)
  const emptyNote = page.getByText('Image and video generation will appear here')
  await expect(emptyNote).toBeVisible()

  const fresh = runningTask('dddddddd-0000-4000-8000-00000000e001', '2026-09-01T09:00:05Z')
  await page.evaluate((task) => {
    const controls = window.__creationDeckTest
    controls?.failDetailReads((task as { id: string }).id, 1)
    controls?.pushTask(task as never)
  }, fresh as never)
  await expect(page.getByTestId(`task-${fresh.id}`)).toBeVisible()
  await expect(page.getByTestId(`slot-${fresh.id}-0`)).toHaveAttribute('data-slot-status', 'queued')
  await expect(page.getByTestId(`task-detail-stale-${fresh.id}`)).toBeVisible()
  await expect(emptyNote).toHaveCount(0)
})

test('A → B → A: the first entry late response never writes into the later context', async ({
  mount,
  page
}) => {
  const task = runningTask('dddddddd-0000-4000-8000-00000000f001', '2026-09-01T09:00:01Z')
  await mount(<CreationWorkbenchStory taskScript={{ tasks: [task] }} />)

  // Hold the first A read, switch to B, and only then let A's response land.
  await page.evaluate(() => {
    window.__creationDeckTest?.holdNextListResponse()
  })
  await selectFirstSession(page)
  await page.getByRole('button', { name: 'Untitled creation', exact: true }).click()
  await expect(page.getByTestId('composer')).toBeVisible()
  await expect(page.getByTestId(`task-${task.id}`)).toHaveCount(0)

  await page.evaluate(() => {
    window.__creationDeckTest?.releaseHeldListResponses()
  })
  // The stale A round is discarded: B keeps its own (empty) task view.
  await expect(page.getByTestId(`task-${task.id}`)).toHaveCount(0)

  // Returning to A reads fresh facts under a new display lifecycle.
  await selectFirstSession(page)
  await expect(page.getByTestId(`task-${task.id}`)).toBeVisible()
})

test('the fallback poll converges the view only while the stream is down', async ({
  mount,
  page
}) => {
  await page.clock.install()
  const task = runningTask('dddddddd-0000-4000-8000-00000000g001', '2026-09-01T09:00:01Z')
  await mount(<CreationWorkbenchStory taskScript={{ tasks: [task] }} />)
  await selectFirstSession(page)
  await expect(page.getByTestId(`slot-${task.id}-0`)).toHaveAttribute(
    'data-slot-status',
    'generating'
  )

  // The stream connects: the reconnect reconcile runs once and the fallback
  // poll retires. A silent server change now stays unread even well past the
  // poll interval — a healthy stream is purely event-driven.
  const callsAfterEntry = await listTasksCalls(page)
  await page.evaluate(() => {
    window.__creationDeckTest?.setStreamLive(true)
  })
  await expect.poll(() => listTasksCalls(page)).toBe(callsAfterEntry + 1)
  const settled = settledTask(task.id, '2026-09-01T09:00:08Z')
  await page.evaluate((updated) => {
    window.__creationDeckTest?.replaceTaskSilently(updated as never)
  }, settled as never)
  await page.clock.fastForward(11_000)
  await expect(page.getByTestId(`slot-${task.id}-0`)).toHaveAttribute(
    'data-slot-status',
    'generating'
  )

  // The stream drops with an in-progress task: the 5-second fallback poll
  // converges the view without any notification.
  await page.evaluate(() => {
    window.__creationDeckTest?.setStreamLive(false)
  })
  await page.clock.fastForward(5_000)
  await expect(page.getByTestId(`slot-${task.id}-0`)).toHaveAttribute(
    'data-slot-status',
    'succeeded'
  )
})

test('a failed list read keeps loaded tasks visible with the unrefreshed note', async ({
  mount,
  page
}) => {
  const task = settledTask('dddddddd-0000-4000-8000-00000000h001', '2026-09-01T09:00:01Z')
  await mount(<CreationWorkbenchStory taskScript={{ tasks: [task] }} />)
  await selectFirstSession(page)
  await expect(page.getByTestId(`task-${task.id}`)).toBeVisible()

  await page.evaluate(() => {
    const controls = window.__creationDeckTest
    controls?.failListReads(1)
    controls?.fireInvalidation()
  })
  await expect(page.getByTestId('task-list-stale')).toBeVisible()
  await expect(page.getByTestId(`task-${task.id}`)).toBeVisible()

  await page.evaluate(() => {
    window.__creationDeckTest?.fireInvalidation()
  })
  await expect(page.getByTestId('task-list-stale')).toHaveCount(0)
  await expect(page.getByTestId(`task-${task.id}`)).toBeVisible()
})
