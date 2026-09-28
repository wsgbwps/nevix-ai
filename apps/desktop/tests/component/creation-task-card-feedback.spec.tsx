import { expect, test } from '@playwright/experimental-ct-react'
import { CreationWorkbenchRealShellStory } from './fixtures/creation-workbench-real-shell.story'
import type { ScriptedTask } from './fixtures/creation-workbench.story'

test('unfinished slot motion pauses for reduced motion while its status stays visible', async ({
  mount,
  page
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const running: ScriptedTask = {
    id: 'task-activity',
    sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
    status: 'processing',
    mediaType: 'image',
    slotCount: 1,
    snapshot: null,
    cancelRequested: false,
    terminalCause: null,
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt: '2026-09-01T09:00:01Z',
    terminalAt: null,
    slots: [{ index: 0, status: 'generating', failureReason: null, result: null }]
  }
  const finished: ScriptedTask = {
    ...running,
    id: 'task-finished',
    status: 'succeeded',
    createdAt: '2026-09-01T09:01:00Z',
    updatedAt: '2026-09-01T09:01:01Z',
    terminalAt: '2026-09-01T09:01:01Z',
    slots: [
      {
        index: 0,
        status: 'succeeded',
        failureReason: null,
        result: {
          mimeType: 'image/jpeg',
          byteSize: 2048,
          checksumSha256: 'ab'.repeat(32),
          widthPx: 1024,
          heightPx: 1024,
          durationMs: null
        }
      }
    ]
  }
  await mount(
    <CreationWorkbenchRealShellStory
      taskScript={{ tasks: [running, finished], resultBlobDeferred: true }}
    />
  )
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()

  const activity = page.getByTestId(`slot-activity-${running.id}-0`)
  const mediaSkeleton = page.getByTestId(`slot-${finished.id}-0`).locator('[data-slot="skeleton"]')
  await expect(activity).toBeVisible()
  await expect
    .poll(() => activity.evaluate((element) => getComputedStyle(element, '::after').animationName))
    .toBe('skeleton-shimmer')
  await expect(mediaSkeleton).toHaveCount(1)
  await expect
    .poll(() =>
      mediaSkeleton.evaluate((element) => getComputedStyle(element, '::after').animationName)
    )
    .toBe('none')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect
    .poll(() => activity.evaluate((element) => getComputedStyle(element, '::after').animationName))
    .toBe('none')
  await expect(activity).toHaveCSS('height', '2px')
  await expect(page.getByTestId(`slot-${running.id}-0`)).toContainText('Generating')
})
