import { expect, test } from '@playwright/experimental-ct-react'
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
  const tallTasks: ScriptedTask[] = [1, 2, 3].map((n) => ({
    id: `dddddddd-0000-4000-8000-0000000scroll${String(n).padStart(2, '0')}`,
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
  const scroller = workspace.locator('div').first()
  // Settle the mount-time reveal: the scroller really is at the bottom once
  // its height is bounded; before the fix it trivially had no overflow.
  await expect
    .poll(
      async () =>
        scroller.evaluate((el) => el.scrollTop > 0 || el.scrollHeight <= el.clientHeight + 1),
      { timeout: 5_000 }
    )
    .toBe(true)
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
  // the workspace must stay exactly where it is.
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
