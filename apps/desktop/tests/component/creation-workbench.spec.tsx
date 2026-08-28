import { expect, test, type Page } from '@playwright/experimental-ct-react'
import { CreationWorkbenchStory } from './fixtures/creation-workbench.story'
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
  image: { available: false, reason: 'not_configured', action: 'contact_admin' },
  video: { available: false, reason: 'not_configured', action: 'contact_admin' }
}

/** A stored draft carrying values the current manifest has removed. */
const staleDraft: SessionDraftInput = {
  prompt: 'legacy campaign draft',
  mediaType: 'image',
  manifestVersion: 1,
  model: 'removed-legacy-model',
  mode: 'reference-image',
  ratio: '7:3',
  resolution: '2K',
  quantity: 2,
  durationSeconds: null,
  references: [{ materialId: 'cccccccc-0000-4000-8000-000000000003', role: 'reference' }]
}

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
  await expect(page.getByTestId('composer-params')).toContainText('×2')
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

test('the deck strip is the only horizontal overflow layer in the composer', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  // CT has no Tailwind runtime, so the structural contract is asserted on
  // class names: only the expanded deck strip scrolls horizontally.
  await page.getByTestId('reference-deck').hover()
  const strip = await page.getByTestId('deck-strip').getAttribute('class')
  expect(strip).toContain('overflow-x-auto')
})

test('submitting stays disabled without faking success', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  const submit = page.getByTestId('composer-submit')
  await expect(submit).toBeDisabled()
  await expect(submit).toHaveAttribute('aria-disabled', 'true')
})
