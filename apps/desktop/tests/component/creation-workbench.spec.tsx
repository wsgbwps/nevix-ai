import { expect, test, type Page } from '@playwright/experimental-ct-react'
import {
  CreationWorkbenchShellStory,
  CreationWorkbenchStory,
  type ScriptedTask
} from './fixtures/creation-workbench.story'
import type { SessionDraftInput } from '../src/renderer/src/features/creation/api/go-creation-http'
import type { CapabilityManifest } from '../src/renderer/src/features/creation/api/capability-manifest-http'

/**
 * Public-surface component tests for the production Creation Workbench
 * (issue #177): recoverable draft, manifest-driven candidates with stale
 * value preservation, the composer reference deck's keyboard equivalence, and
 * the absence of any fake submit success. Only visible UI and the
 * window.__creationDeckTest port-call handle are asserted. Fixture data lives
 * inline — the CT transform only supports importing components from the
 * story module, so data fixtures cannot be shared from there.
 */

/** Both media unavailable: drafting keeps working, action advice shows. */
const noCapabilityManifest: CapabilityManifest = {
  schemaVersion: 1,
  manifestVersion: 1,
  updatedAt: '2026-08-29T10:00:00Z',
  image: { available: false, reason: 'not_configured', action: 'contact_admin' },
  video: { available: false, reason: 'not_configured', action: 'contact_admin' }
}

/** A stored draft carrying values the current manifest has removed. */
const staleDraft: SessionDraftInput = {
  prompt: 'legacy campaign draft',
  mediaType: 'image',
  manifestVersion: 1,
  updatedAt: '2026-08-29T10:00:00Z',
  model: 'removed-legacy-model',
  mode: 'reference-image',
  ratio: '7:3',
  resolution: '2K',
  quantity: 2,
  durationSeconds: null,
  references: [{ materialId: 'cccccccc-0000-4000-8000-000000000003', role: 'reference' }]
}

// The scripted session id the fixture mounts by default (kept local: the
// fixture file carries top-level await and must not leak runtime values here).
const scriptedSessionId = 'aaaaaaaa-0000-4000-8000-000000000001'

interface SaveCall {
  sessionId: string
  draft: {
    prompt: string
    mediaType: string | null
    manifestVersion: number
    references: Array<{ materialId: string; role: string }>
  }
}

function saveDraftCalls(page: Page): Promise<SaveCall[]> {
  return page.evaluate(() => window.__creationDeckTest?.saveDraftCalls() ?? [])
}

function deleteMaterialCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__creationDeckTest?.deleteMaterialCalls() ?? [])
}

async function selectFirstSession(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
  await expect(page.getByTestId('composer')).toBeVisible()
}

test('an empty library shows every explicit state: list, empty note, workspace empty', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory sessions={[]} />)

  const workbench = page.getByTestId('creation-workbench')
  await expect(workbench).toBeVisible()
  await expect(workbench.getByRole('complementary')).toContainText(
    'No creation sessions yet; start from a blank draft'
  )
  await expect(workbench.getByText('Pick or create a session to start your work')).toBeVisible()
  // No session selected — no composer, no fake submission surface.
  await expect(page.getByTestId('composer')).toHaveCount(0)
})

test('an empty draft greets with the hero and a template card fills the prompt', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory />)
  await page.getByRole('button', { name: 'Untitled creation', exact: true }).click()
  await expect(page.getByTestId('composer')).toBeVisible()

  const hero = page.getByTestId('workspace-hero')
  await expect(hero).toBeVisible()
  await expect(page.getByTestId('composer-prompt')).toHaveValue('')

  // A starter template writes the draft prompt; the save keeps autosaving.
  await hero.getByTestId('template-card-scene').click()
  const scenePrompt =
    'Place the product into a clean, bright lifestyle scene that highlights its real materials and key selling points.'
  await expect(page.getByTestId('composer-prompt')).toHaveValue(scenePrompt)
  // The hero yields once the draft holds a prompt.
  await expect(page.getByTestId('workspace-hero')).toHaveCount(0)
  await expect
    .poll(async () => (await saveDraftCalls(page)).at(-1)?.draft.prompt, { timeout: 5_000 })
    .toBe(scenePrompt)
})

test('selecting a session recovers its stored draft verbatim', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  await expect(page.getByTestId('composer-prompt')).toHaveValue('夏季跑鞋主图，暖光背景')
  await expect(page.getByTestId('composer-media')).toContainText('Image generation')
  await expect(page.getByTestId('composer-model')).toContainText('doubao-seedream-5.0-lite')
  await expect(page.getByTestId('composer-params')).toContainText('4:5')
  await expect(page.getByTestId('composer-params')).toContainText('2K')
  await expect(page.getByTestId('composer-params').getByText('2', { exact: true })).toBeVisible()
})

test('editing the prompt autosaves the full draft with its ordered references', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  await page.getByTestId('composer-prompt').fill('暖光背景下的白色运动鞋')
  await expect
    .poll(async () => (await saveDraftCalls(page)).length, { timeout: 5_000 })
    .toBeGreaterThan(0)

  const call = (await saveDraftCalls(page)).at(-1)!
  expect(call.sessionId).toBe('aaaaaaaa-0000-4000-8000-000000000001')
  expect(call.draft.prompt).toBe('暖光背景下的白色运动鞋')
  // The ordered reference identity/role list rides the same atomic save.
  expect(call.draft.references.map((entry) => entry.role)).toEqual(['reference', 'reference'])
  await expect(page.getByTestId('composer-save')).toContainText('Draft saved')
})

test('a stale draft value is preserved verbatim and marked as capability-changed', async ({
  mount,
  page
}) => {
  await mount(
    <CreationWorkbenchStory drafts={{ 'aaaaaaaa-0000-4000-8000-000000000001': staleDraft }} />
  )
  await selectFirstSession(page)

  // The stale model stays displayed on its trigger — never rewritten.
  await expect(page.getByTestId('composer-model')).toContainText('removed-legacy-model')
  // The params trigger keeps the removed ratio while the legal 2K stands.
  await expect(page.getByTestId('composer-params')).toContainText('7:3')
  await expect(page.getByTestId('composer-params')).toContainText('2K')
})

test('the model menu lists only manifest candidates plus the stale note', async ({
  mount,
  page
}) => {
  await mount(
    <CreationWorkbenchStory drafts={{ 'aaaaaaaa-0000-4000-8000-000000000001': staleDraft }} />
  )
  await selectFirstSession(page)

  await page.getByTestId('composer-model').click()
  // Legal candidates come from the manifest only; the removed model is not a
  // selectable candidate.
  const menu = page.getByRole('menu')
  await expect(menu).toContainText('doubao-seedream-5.0-lite')
  await expect(menu.getByRole('menuitem').filter({ hasText: 'removed-legacy-model' })).toHaveCount(
    0
  )
  // The stale value is preserved and explained.
  await expect(menu.getByRole('note')).toContainText('removed-legacy-model')
  await expect(menu.getByRole('note')).toContainText('Capability changed')
  await page.keyboard.press('Escape')
})

test('an unreachable manifest still allows drafting and autosave', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory manifestFails />)
  await selectFirstSession(page)

  await expect(page.getByTestId('composer-unavailable')).toContainText(
    'capability manifest is unavailable'
  )
  await page.getByTestId('composer-prompt').fill('offline draft still saves')
  await expect
    .poll(async () => (await saveDraftCalls(page)).length, { timeout: 5_000 })
    .toBeGreaterThan(0)
  expect((await saveDraftCalls(page)).at(-1)!.draft.prompt).toBe('offline draft still saves')
})

test('no available media capability keeps the composer editable with stable advice', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory manifest={noCapabilityManifest} />)
  await selectFirstSession(page)

  await expect(page.getByTestId('composer-unavailable')).toContainText(
    'No generation capability is available'
  )
  await expect(page.getByTestId('composer-unavailable')).toContainText(
    'Please contact your administrator'
  )
  await page.getByTestId('composer-prompt').fill('prompt before any provider exists')
  await expect
    .poll(async () => (await saveDraftCalls(page)).length, { timeout: 5_000 })
    .toBeGreaterThan(0)
})

test('the reference deck expands on focus with full keyboard equivalence', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  const deck = page.getByTestId('reference-deck')
  const firstCard = deck.getByRole('button', { name: 'poster.png', exact: true }).first()
  await firstCard.focus()
  // Focus expands the deck in place — the hover interaction has a keyboard
  // equivalent.
  await expect(deck.getByTestId('deck-strip')).toBeVisible()
  const secondCard = deck.getByRole('button', { name: 'banner.png', exact: true })
  await expect(secondCard).toBeVisible()

  // ArrowRight moves real DOM focus to the next card.
  await page.keyboard.press('ArrowRight')
  await expect(secondCard).toBeFocused()

  // Delete removes the focused card through the trusted material command.
  await page.keyboard.press('Delete')
  await expect
    .poll(() => deleteMaterialCalls(page))
    .toContain('dddddddd-0000-4000-8000-000000000004')
})

test('the expanded deck overlays in place instead of squeezing the prompt', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  // The prototype expands the pile over the workspace: the prompt's geometry
  // must not shift when the fan opens (bounded by the 4-reference cap).
  const prompt = page.getByTestId('composer-prompt')
  const before = await prompt.boundingBox()
  await page.getByTestId('reference-deck').hover()
  await expect(page.getByTestId('deck-strip')).toBeVisible()
  const after = await prompt.boundingBox()
  expect(after?.x).toBe(before?.x)
  expect(after?.width).toBe(before?.width)
})

test('submitting stays disabled while capability context is missing', async ({ mount, page }) => {
  // The submit command freezes a manifest-conformant intent: without a live
  // manifest (or without a complete draft) the affordance stays inert rather
  // than guessing a submission the server would have to reject.
  await mount(<CreationWorkbenchStory manifestFails />)
  await selectFirstSession(page)

  const submit = page.getByTestId('composer-submit')
  await expect(submit).toBeDisabled()
  await expect(submit).toHaveAttribute('aria-disabled', 'true')
})

test('submitting creates a generation task and renders the slot gallery', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  const submit = page.getByTestId('composer-submit')
  await expect(submit).toBeEnabled()
  await submit.click()

  const taskCalls = await page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? [])
  expect(taskCalls).toHaveLength(1)
  expect(taskCalls[0].idempotencyKey).not.toBe('')

  // The gallery shows the admitted task with its stable ordered slots.
  await expect(page.getByTestId('result-gallery')).toBeVisible()
  const slots = page.locator('[data-testid^="slot-dddddddd"]')
  await expect(slots).toHaveCount(2)
  await expect(slots.first()).toHaveAttribute('data-slot-status', 'queued')
})

test('slot states, failure reasons, and task actions render inline', async ({ mount, page }) => {
  const failedTask: ScriptedTask = {
    id: 'dddddddd-0000-4000-8000-00000000face',
    sessionId: scriptedSessionId,
    status: 'partially_succeeded',
    mediaType: 'image',
    slotCount: 2,
    cancelRequested: false,
    terminalCause: null,
    createdAt: '2026-08-29T09:00:00Z',
    updatedAt: '2026-08-29T09:01:00Z',
    terminalAt: '2026-08-29T09:01:00Z',
    slots: [
      { index: 0, status: 'succeeded', failureReason: null, result: null },
      {
        index: 1,
        status: 'failed',
        failureReason: 'temporarily_unavailable',
        result: null
      }
    ]
  }
  await mount(<CreationWorkbenchStory taskScript={{ tasks: [failedTask] }} />)
  await selectFirstSession(page)

  // States render inside the slots — no separate banner.
  await expect(page.getByTestId(`slot-${failedTask.id}-0`)).toHaveAttribute(
    'data-slot-status',
    'succeeded'
  )
  await expect(page.getByTestId(`slot-${failedTask.id}-1`)).toHaveAttribute(
    'data-slot-status',
    'failed'
  )
  await expect(page.getByTestId(`slot-${failedTask.id}-1`)).toContainText(
    'Provider temporarily unavailable'
  )

  // Partial success keeps retrying exactly the uncompleted slots.
  await page.getByTestId(`task-retry-${failedTask.id}`).click()
  const retries = await page.evaluate(() => window.__creationDeckTest?.retryCalls() ?? [])
  expect(retries).toHaveLength(1)
  expect(retries[0].taskId).toBe(failedTask.id)
})

test('cancel requests best-effort convergence on a running task', async ({ mount, page }) => {
  const runningTask: ScriptedTask = {
    id: 'dddddddd-0000-4000-8000-00000000run1',
    sessionId: scriptedSessionId,
    status: 'processing',
    mediaType: 'image',
    slotCount: 1,
    cancelRequested: false,
    terminalCause: null,
    createdAt: '2026-08-29T09:00:00Z',
    updatedAt: '2026-08-29T09:00:01Z',
    terminalAt: null,
    slots: [{ index: 0, status: 'generating', failureReason: null, result: null }]
  }
  await mount(<CreationWorkbenchStory taskScript={{ tasks: [runningTask] }} />)
  await selectFirstSession(page)

  await page.getByTestId(`task-cancel-${runningTask.id}`).click()
  const cancelled = await page.evaluate(() => window.__creationDeckTest?.cancelledIds() ?? [])
  expect(cancelled).toEqual([runningTask.id])
})

test('indeterminate outcomes require an explicit risk confirmation before redo', async ({
  mount,
  page
}) => {
  const unknownTask: ScriptedTask = {
    id: 'dddddddd-0000-4000-8000-00000000unk1',
    sessionId: scriptedSessionId,
    status: 'failed',
    mediaType: 'image',
    slotCount: 1,
    cancelRequested: false,
    terminalCause: 'provider_outcome_indeterminate',
    createdAt: '2026-08-29T09:00:00Z',
    updatedAt: '2026-08-29T09:00:02Z',
    terminalAt: '2026-08-29T09:00:02Z',
    slots: [
      {
        index: 0,
        status: 'indeterminate',
        failureReason: 'processing_indeterminate',
        result: null
      }
    ]
  }
  await mount(<CreationWorkbenchStory taskScript={{ tasks: [unknownTask] }} />)
  await selectFirstSession(page)

  // The redo affordance opens the risk dialog; the retry fires only after the
  // creator confirms the repeat-generation/billing risk.
  await page.getByTestId(`task-retry-indeterminate-${unknownTask.id}`).click()
  const before = await page.evaluate(() => window.__creationDeckTest?.retryCalls() ?? [])
  expect(before).toHaveLength(0)
  await expect(page.getByTestId(`indeterminate-confirm-${unknownTask.id}`)).toBeVisible()
  await page.getByTestId(`indeterminate-confirm-button-${unknownTask.id}`).click()
  const after = await page.evaluate(() => window.__creationDeckTest?.retryCalls() ?? [])
  expect(after).toHaveLength(1)
  expect(after[0].taskId).toBe(unknownTask.id)
})

test('an SSE invalidation refetches the task list', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  const pushed: ScriptedTask = {
    id: 'dddddddd-0000-4000-8000-00000000pus1',
    sessionId: scriptedSessionId,
    status: 'processing',
    mediaType: 'video',
    slotCount: 1,
    cancelRequested: false,
    terminalCause: null,
    createdAt: '2026-08-29T09:05:00Z',
    updatedAt: '2026-08-29T09:05:01Z',
    terminalAt: null,
    slots: [{ index: 0, status: 'generating', failureReason: null, result: null }]
  }
  // The scripted server commits the task and fires the invalidation in the
  // same instant — commit-before-notify from the fixture's point of view.
  await page.evaluate((task) => {
    window.__creationDeckTest?.pushTask(task as never)
  }, pushed as never)
  await expect(page.getByTestId(`task-${pushed.id}`)).toBeVisible()
  await expect(page.getByTestId(`slot-${pushed.id}-0`)).toHaveAttribute(
    'data-slot-status',
    'generating'
  )
})

test('the workbench fills the shell content area it is mounted in', async ({ mount, page }) => {
  // Regression for the desktop fill bug: the page used to sit behind a plain
  // block wrapper in app/pages/creation-page.tsx, which made the section's
  // flex-1 inert and left dead space under the composer. The story mounts the
  // real page exactly as the App Shell does — direct child of the shell's
  // flex-col content container inside a definite-height inset. Seam note: the
  // real CreationPage composition (auth + connection providers) is not
  // CT-mountable, so this pins the shell↔page fill contract, not that file's
  // own JSX; keep creation-page.tsx wrapper-free.
  await mount(<CreationWorkbenchShellStory />)
  await selectFirstSession(page)

  const section = await page.getByTestId('creation-workbench').boundingBox()
  const shell = await page.getByTestId('shell-content').boundingBox()
  expect(section!.y).toBeCloseTo(shell!.y, 0)
  expect(section!.height).toBeGreaterThanOrEqual(shell!.height - 1)
})

test('a succeeded image slot offers a keyboard-reachable download', async ({ mount, page }) => {
  const doneTask: ScriptedTask = {
    id: 'dddddddd-0000-4000-8000-00000000dl00',
    sessionId: scriptedSessionId,
    status: 'succeeded',
    mediaType: 'image',
    slotCount: 1,
    cancelRequested: false,
    terminalCause: null,
    createdAt: '2026-08-29T09:00:00Z',
    updatedAt: '2026-08-29T09:01:00Z',
    terminalAt: '2026-08-29T09:01:00Z',
    slots: [{ index: 0, status: 'succeeded', failureReason: null, result: null }]
  }
  await mount(<CreationWorkbenchStory taskScript={{ tasks: [doneTask] }} />)
  await selectFirstSession(page)

  // Record programmatic anchor activations instead of navigating the CT page.
  await page.evaluate(() => {
    const calls: Array<{ href: string; download: string }> = []
    ;(window as unknown as { __downloadCalls: typeof calls }).__downloadCalls = calls
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      calls.push({ href: this.href, download: this.download })
    }
  })

  const button = page.getByTestId(`slot-download-${doneTask.id}-0`)
  await expect(button).toBeVisible()
  await button.focus()
  await button.click()

  const calls = await page.evaluate(
    () =>
      (window as unknown as { __downloadCalls?: Array<{ href: string; download: string }> })
        .__downloadCalls ?? []
  )
  expect(calls).toHaveLength(1)
  expect(calls[0].download).toBe(`nevix-${doneTask.id.slice(0, 8)}-1.png`)
  expect(calls[0].href).toContain('data:image')
})

test('a policy-rejected task keeps editing paths but no identical quick retry', async ({
  mount,
  page
}) => {
  const rejectedTask: ScriptedTask = {
    id: 'dddddddd-0000-4000-8000-00000000p0li',
    sessionId: scriptedSessionId,
    status: 'failed',
    mediaType: 'image',
    slotCount: 2,
    cancelRequested: false,
    terminalCause: null,
    createdAt: '2026-08-29T09:00:00Z',
    updatedAt: '2026-08-29T09:01:00Z',
    terminalAt: '2026-08-29T09:01:00Z',
    slots: [
      { index: 0, status: 'failed', failureReason: 'input_policy_rejected', result: null },
      { index: 1, status: 'failed', failureReason: 'input_policy_rejected', result: null }
    ]
  }
  await mount(<CreationWorkbenchStory taskScript={{ tasks: [rejectedTask] }} />)
  await selectFirstSession(page)

  // The identical-content retry is forbidden; editing and regenerating stays.
  await expect(page.getByTestId(`task-retry-${rejectedTask.id}`)).toHaveCount(0)
  await expect(page.getByTestId(`task-regenerate-${rejectedTask.id}`)).toBeVisible()
  await expect(page.getByTestId(`slot-${rejectedTask.id}-0`)).toContainText(
    'Input rejected by safety review'
  )
})
