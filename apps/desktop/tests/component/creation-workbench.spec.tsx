import { expect, test, type Page } from '@playwright/experimental-ct-react'
import {
  CreationWorkbenchShellStory,
  CreationWorkbenchStory,
  type ScriptedTask
} from './fixtures/creation-workbench.story'
import type { LocalDraftRecord } from '../src/renderer/src/features/creation/model/draft-store'
import type { CapabilityManifest } from '../src/renderer/src/features/creation/api/capability-manifest-http'
import type { ReferenceMaterialView } from '../src/renderer/src/features/creation/api/go-creation-http'

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

/** A local draft carrying values the current manifest has removed. */
const staleDraft: LocalDraftRecord = {
  prompt: 'legacy campaign draft',
  promptDocument: {
    version: 1,
    nodes: [{ type: 'text', text: 'legacy campaign draft' }]
  },
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

// The scripted session id the fixture mounts by default (kept local: the
// fixture file carries top-level await and must not leak runtime values here).
const scriptedSessionId = 'aaaaaaaa-0000-4000-8000-000000000001'
const firstMaterialId = 'cccccccc-0000-4000-8000-000000000003'

function scriptedMaterial(
  id: string,
  kind: ReferenceMaterialView['kind'],
  fileName: string
): ReferenceMaterialView {
  return {
    id,
    kind,
    fileName,
    mimeType: kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'image/png',
    byteSize: 1024,
    widthPx: kind === 'audio' ? null : 24,
    heightPx: kind === 'audio' ? null : 16,
    pixelCount: kind === 'image' ? 384 : null,
    durationMs: kind === 'image' ? null : 3000,
    checksumSha256: 'aa'.repeat(32),
    claimsVersion: 1,
    createdAt: '2026-08-23T08:00:00Z'
  }
}

function videoMentionDraft(materialId: string): LocalDraftRecord {
  return {
    prompt: 'Video 1',
    promptDocument: { version: 1, nodes: [{ type: 'mention', materialId }] },
    mediaType: 'video',
    manifestVersion: 5,
    model: 'doubao-seedance-2-5',
    mode: 'omni-reference',
    ratio: null,
    resolution: '720p',
    quantity: 1,
    durationSeconds: 5,
    references: [{ materialId, role: 'omni' }]
  }
}

/** Reads this device's local draft record through the story's test handle. */
function draftRecord(page: Page, key: string): Promise<LocalDraftRecord | null> {
  return page.evaluate(
    (sessionKey) => window.__creationDeckTest?.draftRecord(sessionKey) ?? null,
    key
  )
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
  await expect(page.getByTestId('composer-prompt')).toHaveText('')

  // A starter template writes the draft prompt; the local store keeps it.
  await hero.getByTestId('template-card-scene').click()
  const scenePrompt =
    'Place the product into a clean, bright lifestyle scene that highlights its real materials and key selling points.'
  await expect(page.getByTestId('composer-prompt')).toHaveText(scenePrompt)
  // The hero yields once the draft holds a prompt.
  await expect(page.getByTestId('workspace-hero')).toHaveCount(0)
  await expect
    .poll(async () => (await draftRecord(page, 'bbbbbbbb-0000-4000-8000-000000000002'))?.prompt, {
      timeout: 5_000
    })
    .toBe(scenePrompt)
})

test('selecting a session recovers its stored draft verbatim', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  await expect(page.getByTestId('composer-prompt')).toHaveText('夏季跑鞋主图，暖光背景')
  await expect(page.getByTestId('composer-media')).toContainText('Image generation')
  await expect(page.getByTestId('composer-model')).toContainText('doubao-seedream-5.0-pro')
  await expect(page.getByTestId('composer-params')).toContainText('4:3')
  await expect(page.getByTestId('composer-params')).toContainText('2K')
  await expect(page.getByTestId('composer-params').getByText('2', { exact: true })).toBeVisible()
})

test('manifest defaults persist locally with the version delivered in the same response', async ({
  mount,
  page
}) => {
  await mount(
    <CreationWorkbenchStory
      manifestDeferred
      drafts={{ 'aaaaaaaa-0000-4000-8000-000000000001': null }}
    />
  )
  await selectFirstSession(page)

  await page.evaluate(() => window.__creationDeckTest?.releaseManifest())
  await expect(page.getByTestId('composer-model')).toContainText('doubao-seedream-5.0-pro')
  await expect
    .poll(
      async () =>
        (await draftRecord(page, 'aaaaaaaa-0000-4000-8000-000000000001'))?.manifestVersion,
      { timeout: 5_000 }
    )
    .toBe(5)
})

test('editing the prompt persists the full draft with its ordered references locally', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  await page.getByTestId('composer-prompt').fill('暖光背景下的白色运动鞋')
  await expect
    .poll(async () => (await draftRecord(page, 'aaaaaaaa-0000-4000-8000-000000000001'))?.prompt, {
      timeout: 5_000
    })
    .toBe('暖光背景下的白色运动鞋')
  const record = await draftRecord(page, 'aaaaaaaa-0000-4000-8000-000000000001')
  // The ordered reference identity/role list rides the same local record.
  expect(record?.references.map((entry) => entry.role)).toEqual(['reference', 'reference'])
})

test('mention-only prompts submit localized plain text without leaking document identity', async ({
  mount,
  page
}) => {
  const draft: LocalDraftRecord = {
    prompt: 'Image 1Image 1',
    promptDocument: {
      version: 1,
      nodes: [
        { type: 'mention', materialId: firstMaterialId },
        { type: 'mention', materialId: firstMaterialId }
      ]
    },
    mediaType: 'image',
    manifestVersion: 5,
    model: 'doubao-seedream-5.0-pro',
    mode: 'reference-image',
    ratio: '4:3',
    resolution: '2K',
    quantity: 1,
    durationSeconds: null,
    references: [{ materialId: firstMaterialId, role: 'reference' }]
  }
  await mount(<CreationWorkbenchStory drafts={{ [scriptedSessionId]: draft }} />)
  await selectFirstSession(page)

  await expect(page.getByRole('button', { name: 'Image 1' })).toHaveCount(2)
  await expect(page.getByTestId('composer-submit')).toBeEnabled()
  await page.getByTestId('composer-submit').click()

  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? []))
    .toHaveLength(1)
  const [call] = await page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? [])
  expect(call?.intent.prompt).toBe('Image 1Image 1')
  expect(call?.intent.references).toEqual([{ materialId: firstMaterialId, role: 'reference' }])
  expect(Object.hasOwn(call?.intent ?? {}, 'promptDocument')).toBe(false)
})

test('restoring a draft prunes dangling mentions and writes through the recovered text', async ({
  mount,
  page
}) => {
  const draft: LocalDraftRecord = {
    prompt: 'beforemissingafter',
    promptDocument: {
      version: 1,
      nodes: [
        { type: 'text', text: 'before' },
        { type: 'mention', materialId: 'missing-material' },
        { type: 'text', text: 'after' }
      ]
    },
    mediaType: 'image',
    manifestVersion: 5,
    model: 'doubao-seedream-5.0-pro',
    mode: 'reference-image',
    ratio: '4:3',
    resolution: '2K',
    quantity: 1,
    durationSeconds: null,
    references: [{ materialId: firstMaterialId, role: 'reference' }]
  }
  await mount(<CreationWorkbenchStory drafts={{ [scriptedSessionId]: draft }} />)
  await selectFirstSession(page)

  await expect(
    page.getByText('Unavailable references were removed and their mentions kept as text.')
  ).toBeVisible()
  await expect(page.getByTestId('composer-prompt')).toHaveText('beforemissingafter')
  await expect
    .poll(async () => (await draftRecord(page, scriptedSessionId))?.promptDocument)
    .toEqual({ version: 1, nodes: [{ type: 'text', text: 'beforemissingafter' }] })

  await page.getByRole('button', { name: 'Untitled creation', exact: true }).click()
  await expect(
    page.getByText('Unavailable references were removed and their mentions kept as text.')
  ).toHaveCount(0)
})

test('reloading a composing draft keeps pending-file mentions as fallback text', async ({
  mount,
  page
}) => {
  const pendingId = 'pending-before-reload'
  const draft: LocalDraftRecord = {
    prompt: 'Image 1',
    promptDocument: { version: 1, nodes: [{ type: 'mention', materialId: pendingId }] },
    mediaType: 'image',
    manifestVersion: 5,
    model: 'doubao-seedream-5.0-pro',
    mode: 'reference-image',
    ratio: '4:3',
    resolution: '2K',
    quantity: 1,
    durationSeconds: null,
    references: [{ materialId: pendingId, role: 'reference' }]
  }
  await mount(<CreationWorkbenchStory drafts={{ new: draft }} />)
  await page.getByTestId('session-new').click()

  await expect(page.getByTestId('composer-prompt')).toHaveText('Image 1')
  await expect
    .poll(async () => draftRecord(page, 'new'))
    .toMatchObject({
      prompt: 'Image 1',
      promptDocument: { version: 1, nodes: [{ type: 'text', text: 'Image 1' }] },
      mode: 'text-to-image',
      references: []
    })
})

test('removing a mentioned material confirms the count and cannot be undone in the editor', async ({
  mount,
  page
}) => {
  const draft: LocalDraftRecord = {
    prompt: 'AImage 1BImage 1C',
    promptDocument: {
      version: 1,
      nodes: [
        { type: 'text', text: 'A' },
        { type: 'mention', materialId: firstMaterialId },
        { type: 'text', text: 'B' },
        { type: 'mention', materialId: firstMaterialId },
        { type: 'text', text: 'C' }
      ]
    },
    mediaType: 'image',
    manifestVersion: 5,
    model: 'doubao-seedream-5.0-pro',
    mode: 'reference-image',
    ratio: '4:3',
    resolution: '2K',
    quantity: 1,
    durationSeconds: null,
    references: [{ materialId: firstMaterialId, role: 'reference' }]
  }
  await mount(<CreationWorkbenchStory drafts={{ [scriptedSessionId]: draft }} />)
  await selectFirstSession(page)

  const deckCard = page.getByTestId('reference-deck').getByRole('button', {
    name: 'poster.png',
    exact: true
  })
  await deckCard.focus()
  await page.keyboard.press('Delete')
  const dialog = page.getByRole('dialog', { name: 'Remove reference material?' })
  await expect(dialog).toContainText('2 mention(s)')
  expect(await deleteMaterialCalls(page)).toEqual([])

  await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Image 1' })).toHaveCount(0)
  await expect.poll(() => deleteMaterialCalls(page)).toEqual([firstMaterialId])
  await expect
    .poll(async () => (await draftRecord(page, scriptedSessionId))?.promptDocument)
    .toEqual({ version: 1, nodes: [{ type: 'text', text: 'ABC' }] })

  await page.getByTestId('composer-prompt').focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.getByRole('button', { name: 'Image 1' })).toHaveCount(0)
})

test('video mention hover stays metadata-only and full preview retries then reuses its URL', async ({
  mount,
  page
}) => {
  const videoId = '12121212-0000-4000-8000-000000000012'
  const video = scriptedMaterial(videoId, 'video', 'walkthrough.mp4')
  await mount(
    <CreationWorkbenchStory
      drafts={{ [scriptedSessionId]: videoMentionDraft(videoId) }}
      materials={{ [scriptedSessionId]: [video] }}
      materialBlobFailures={1}
    />
  )
  await selectFirstSession(page)

  const chip = page.getByRole('button', { name: 'Video 1' })
  await chip.focus()
  await expect(page.getByTestId('reference-hover-preview')).toContainText('3s')

  await chip.hover()
  await expect(page.getByTestId('reference-hover-preview')).toContainText('3s')
  expect(await page.evaluate(() => window.__creationDeckTest?.materialBlobCalls() ?? [])).toEqual(
    []
  )

  await chip.click()
  const preview = page.getByTestId('reference-full-preview')
  await expect(preview.getByRole('alert')).toContainText('Material could not be loaded')
  await preview.getByRole('button', { name: 'Retry' }).click()
  await expect(preview.locator('video')).toBeVisible()
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.materialBlobCalls() ?? []))
    .toHaveLength(2)

  await page.keyboard.press('Escape')
  await expect(chip).toBeFocused()
  await chip.click()
  await expect(preview.locator('video')).toBeVisible()
  await page.waitForTimeout(50)
  expect(
    await page.evaluate(() => window.__creationDeckTest?.materialBlobCalls() ?? [])
  ).toHaveLength(2)
})

test('closing a loading full preview aborts the material request', async ({ mount, page }) => {
  const videoId = '13131313-0000-4000-8000-000000000013'
  const video = scriptedMaterial(videoId, 'video', 'deferred.mp4')
  await mount(
    <CreationWorkbenchStory
      drafts={{ [scriptedSessionId]: videoMentionDraft(videoId) }}
      materials={{ [scriptedSessionId]: [video] }}
      materialBlobDeferred
    />
  )
  await selectFirstSession(page)

  const chip = page.getByRole('button', { name: 'Video 1' })
  await chip.click()
  await expect(page.getByTestId('reference-full-preview')).toContainText('Loading material')
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.materialBlobCalls() ?? []))
    .toHaveLength(1)

  await page.keyboard.press('Escape')
  await expect
    .poll(async () =>
      page.evaluate(() => window.__creationDeckTest?.materialBlobCalls()[0]?.aborted)
    )
    .toBe(true)
  await expect(chip).toBeFocused()
})

test('a pending image mention hover preserves the local file ratio', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory />)
  await page.getByTestId('session-new').click()

  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByLabel('Add reference material').click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'portrait.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="240"><rect width="120" height="240" fill="blue"/></svg>'
    )
  })

  const editor = page.getByTestId('composer-prompt')
  await editor.fill('@')
  await page.keyboard.press('Enter')
  const chip = page.getByRole('button', { name: 'Image 1' })
  await chip.hover()
  const preview = page.getByTestId('reference-hover-preview')
  await expect(preview).toBeVisible()
  const box = await preview.boundingBox()
  expect(box).not.toBeNull()
  expect(box?.width).toBeCloseTo(180, 0)
  expect((box?.height ?? 0) / (box?.width ?? 1)).toBeCloseTo(2, 1)
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
  // The size row needs a published (model, ratio, resolution); a stale draft
  // has none, so it hides instead of showing a wrong pixel size.
  await page.getByTestId('composer-params').click()
  await expect(page.getByRole('menu').getByTestId('composer-params-size')).toHaveCount(0)
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
  await expect(menu).toContainText('doubao-seedream-5.0-pro')
  await expect(menu.getByRole('menuitem').filter({ hasText: 'removed-legacy-model' })).toHaveCount(
    0
  )
  // The stale value is preserved and explained.
  await expect(menu.getByRole('note')).toContainText('removed-legacy-model')
  await expect(menu.getByRole('note')).toContainText('Capability changed')
  await page.keyboard.press('Escape')
})

test('the resolution tiers follow the selected image model', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  // The stored draft's model (pro) publishes only 1K/1.5K/2K; the base
  // model's 3K/4K do not exist for it.
  await page.getByTestId('composer-params').click()
  const params = page.getByRole('menu')
  await expect(params.getByRole('button', { name: '1.5K' })).toBeVisible()
  await expect(params.getByRole('button', { name: '4K' })).toHaveCount(0)
  // The size row reads the vendor pixels of the current selection (pro 4:3
  // 2K) — exactly what the server submits.
  await expect(params.getByTestId('composer-params-size')).toContainText('2368')
  await expect(params.getByTestId('composer-params-size')).toContainText('1776')
  await page.keyboard.press('Escape')

  // The model menu lists both allowlisted image models; switching adopts the
  // other model's tier set. The stored 2K stands because the base model also
  // publishes it.
  await page.getByTestId('composer-model').click()
  const menu = page.getByRole('menu')
  await expect(
    menu.getByRole('menuitem', { name: 'doubao-seedream-5.0', exact: true })
  ).toBeVisible()
  await menu.getByRole('menuitem', { name: 'doubao-seedream-5.0', exact: true }).click()
  // Exact text: the base id is a prefix of the pro id, so a substring
  // assertion could not tell the switch from a no-op.
  await expect(
    page.getByTestId('composer-model').getByText('doubao-seedream-5.0', { exact: true })
  ).toBeVisible()
  await expect(page.getByTestId('composer-params')).toContainText('2K')

  await page.getByTestId('composer-params').click()
  await expect(params.getByRole('button', { name: '1.5K' })).toHaveCount(0)
  await expect(params.getByRole('button', { name: '3K' })).toBeVisible()
  await expect(params.getByRole('button', { name: '4K' })).toBeVisible()
  // The same tier label resolves to the base model's own pixels.
  await expect(params.getByTestId('composer-params-size')).toContainText('2304')
  await expect(params.getByTestId('composer-params-size')).toContainText('1728')
})

test('the size row follows the selected ratio and resolution', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  await page.getByTestId('composer-params').click()
  const params = page.getByRole('menu')
  await params.getByRole('button', { name: '9:16' }).click()
  await params.getByRole('button', { name: '1K' }).click()
  await expect(params.getByTestId('composer-params-size')).toContainText('800')
  await expect(params.getByTestId('composer-params-size')).toContainText('1424')

  await params.getByRole('button', { name: '1.5K' }).click()
  await expect(params.getByTestId('composer-params-size')).toContainText('1152')
  await expect(params.getByTestId('composer-params-size')).toContainText('2048')
})

test('an unreachable manifest still allows drafting and autosave', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory manifestFails />)
  await selectFirstSession(page)

  await expect(page.getByTestId('composer-unavailable')).toContainText(
    'capability manifest is unavailable'
  )
  await page.getByTestId('composer-prompt').fill('offline draft still saves')
  await expect
    .poll(async () => (await draftRecord(page, scriptedSessionId))?.prompt, { timeout: 5_000 })
    .toBe('offline draft still saves')
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
    .poll(async () => (await draftRecord(page, scriptedSessionId))?.prompt, { timeout: 5_000 })
    .toBe('prompt before any provider exists')
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

test('the reference deck collapses when the pointer leaves a pointer-focused card', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  const deck = page.getByTestId('reference-deck')
  const backCard = deck.getByRole('button', { name: 'poster.png', exact: true })
  const topCard = deck.getByRole('button', { name: 'banner.png', exact: true })
  await deck.hover()
  await backCard.click()
  await expect
    .poll(async () => {
      const back = await backCard.boundingBox()
      const top = await topCard.boundingBox()
      return Math.abs((back?.x ?? 0) - (top?.x ?? 0))
    })
    .toBeGreaterThan(25)

  await page.mouse.move(0, 0)
  await expect
    .poll(async () => {
      const back = await backCard.boundingBox()
      const top = await topCard.boundingBox()
      return Math.abs((back?.x ?? 0) - (top?.x ?? 0))
    })
    .toBeLessThan(15)
})

test('adding a reference flips the image draft to reference-image and back', async ({
  mount,
  page
}) => {
  // Image modes are deck-derived: the composer offers no image mode picker,
  // so the deck's contents decide the shape (text-to-image ⇄ reference-image).
  await mount(
    <CreationWorkbenchStory
      drafts={{
        [scriptedSessionId]: {
          prompt: '',
          promptDocument: { version: 1, nodes: [{ type: 'text', text: '' }] },
          mediaType: 'image',
          manifestVersion: 5,
          model: 'doubao-seedream-5.0-pro',
          mode: 'text-to-image',
          ratio: '1:1',
          resolution: '2K',
          quantity: 1,
          durationSeconds: null,
          references: []
        }
      }}
      materials={{ [scriptedSessionId]: [] }}
    />
  )
  await selectFirstSession(page)

  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByLabel('Add reference material').click()
  const chooser = await chooserPromise
  await chooser.setFiles({ name: 'ref.png', mimeType: 'image/png', buffer: Buffer.from('png') })
  await expect
    .poll(async () => (await draftRecord(page, scriptedSessionId))?.mode, { timeout: 5_000 })
    .toBe('reference-image')

  // Removing the only card flips the derived mode back: an empty
  // reference-image draft could never satisfy its own minimum.
  const deck = page.getByTestId('reference-deck')
  await deck.getByRole('button', { name: 'ref.png', exact: true }).click()
  await page.keyboard.press('Delete')
  await expect
    .poll(async () => (await draftRecord(page, scriptedSessionId))?.mode, { timeout: 5_000 })
    .toBe('text-to-image')
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
        failureReason: 'provider_route_unavailable',
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
  const failedSlot = page.getByTestId(`slot-${failedTask.id}-1`)
  await expect(failedSlot).toContainText('MODEL_GROUP_ALL_UNAVAILABLE')
  await expect(failedSlot).toContainText(
    'channel binding, permissions, balance, quota, or capacity'
  )

  // Partial success keeps retrying exactly the uncompleted slots; the redo
  // affordance lives in the task's overflow menu.
  await page.getByTestId(`task-more-${failedTask.id}`).click()
  await page.getByTestId(`task-retry-${failedTask.id}`).click()
  const retries = await page.evaluate(() => window.__creationDeckTest?.retryCalls() ?? [])
  expect(retries).toHaveLength(1)
  expect(retries[0].taskId).toBe(failedTask.id)
})

test('a task card keeps detail facts paired with the detail change criterion', async ({
  mount,
  page
}) => {
  const summary: ScriptedTask = {
    id: 'dddddddd-0000-4000-8000-00000000pair',
    sessionId: scriptedSessionId,
    status: 'succeeded',
    mediaType: 'image',
    slotCount: 1,
    cancelRequested: false,
    terminalCause: null,
    createdAt: '2026-09-05T01:00:00Z',
    updatedAt: '2026-09-05T01:00:00.123457Z',
    terminalAt: '2026-09-05T01:00:00.123457Z',
    detailTask: {
      id: 'dddddddd-0000-4000-8000-00000000pair',
      sessionId: scriptedSessionId,
      status: 'queued',
      mediaType: 'image',
      slotCount: 1,
      cancelRequested: false,
      terminalCause: null,
      createdAt: '2026-09-05T01:00:00Z',
      updatedAt: '2026-09-05T01:00:00.123456Z',
      terminalAt: null
    },
    slots: [{ index: 0, status: 'queued', failureReason: null, result: null }]
  }

  await mount(<CreationWorkbenchStory taskScript={{ tasks: [summary] }} />)
  await selectFirstSession(page)

  const card = page.getByTestId(`task-${summary.id}`)
  await expect(card).toContainText('Queued')
  await expect(page.getByTestId(`task-cancel-${summary.id}`)).toBeVisible()
  await expect(page.getByTestId(`task-regenerate-${summary.id}`)).toHaveCount(0)
})

test('a failed slot renders the concrete persisted diagnostic instead of only a generic reason', async ({
  mount,
  page
}) => {
  const failedTask = {
    id: 'dddddddd-0000-4000-8000-00000000diag',
    sessionId: scriptedSessionId,
    status: 'failed',
    mediaType: 'image',
    slotCount: 1,
    cancelRequested: false,
    terminalCause: null,
    createdAt: '2026-09-01T02:59:32Z',
    updatedAt: '2026-09-01T03:00:00Z',
    terminalAt: '2026-09-01T03:00:00Z',
    slots: [
      {
        index: 0,
        status: 'failed',
        failureReason: 'temporarily_unavailable',
        failureDiagnostic: {
          source: 'output_transfer',
          code: 'provider_output_http_status',
          message: 'Provider output download returned HTTP 403',
          httpStatus: 403,
          providerType: null,
          requestId: null
        },
        result: null
      }
    ]
  } as unknown as ScriptedTask

  await mount(<CreationWorkbenchStory taskScript={{ tasks: [failedTask] }} />)
  await selectFirstSession(page)

  const failedSlot = page.getByTestId(`slot-${failedTask.id}-0`)
  await expect(failedSlot).toContainText('provider_output_http_status')
  await expect(failedSlot).toContainText('Provider output download returned HTTP 403')
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
  await page.getByTestId(`task-more-${unknownTask.id}`).click()
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

test('the gallery lists tasks old→new with the newest nearest the composer', async ({
  mount,
  page
}) => {
  // The scripted server pages tasks newest-first, exactly like the real wire
  // order; the gallery displays the reversal so the latest task sits at the
  // bottom of the old→new stack.
  const older: ScriptedTask = {
    id: 'dddddddd-0000-4000-8000-00000000old1',
    sessionId: scriptedSessionId,
    status: 'succeeded',
    mediaType: 'image',
    slotCount: 1,
    cancelRequested: false,
    terminalCause: null,
    createdAt: '2026-08-28T09:00:00Z',
    updatedAt: '2026-08-28T09:01:00Z',
    terminalAt: '2026-08-28T09:01:00Z',
    slots: [{ index: 0, status: 'succeeded', failureReason: null, result: null }]
  }
  const newer: ScriptedTask = {
    id: 'dddddddd-0000-4000-8000-00000000new1',
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
  await mount(<CreationWorkbenchStory taskScript={{ tasks: [newer, older] }} />)
  await selectFirstSession(page)

  const olderBox = await page.getByTestId(`task-${older.id}`).boundingBox()
  const newerBox = await page.getByTestId(`task-${newer.id}`).boundingBox()
  expect(olderBox!.y).toBeLessThan(newerBox!.y)
})

test('clearing the prompt keeps the submitted tasks on screen', async ({ mount, page }) => {
  const runningTask: ScriptedTask = {
    id: 'dddddddd-0000-4000-8000-00000000kee1',
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

  await expect(page.getByTestId('result-gallery')).toBeVisible()

  // Emptying the draft only clears the prompt — the session's task view
  // stays mounted (issue #160 field report: clearing the prompt reset the
  // workspace to the empty hero and hid every submitted task).
  await page.getByTestId('composer-prompt').fill('')
  await expect(page.getByTestId('result-gallery')).toBeVisible()
  await expect(page.getByTestId('workspace-hero')).toHaveCount(0)
})

test('a task card shows its frozen specification, never the live draft', async ({
  mount,
  page
}) => {
  const frozen: ScriptedTask = {
    id: 'dddddddd-0000-4000-8000-00000000frz1',
    sessionId: scriptedSessionId,
    status: 'succeeded',
    mediaType: 'image',
    slotCount: 1,
    cancelRequested: false,
    terminalCause: null,
    createdAt: '2026-08-29T09:00:00Z',
    updatedAt: '2026-08-29T09:01:00Z',
    terminalAt: '2026-08-29T09:01:00Z',
    slots: [{ index: 0, status: 'succeeded', failureReason: null, result: null }],
    specification: {
      prompt: 'frozen-at-submit prompt',
      model: 'frozen-model',
      mode: 'reference-image',
      ratio: '1:1',
      resolution: null,
      quantity: 1,
      durationSeconds: null,
      references: []
    }
  }
  await mount(<CreationWorkbenchStory taskScript={{ tasks: [frozen] }} />)
  await selectFirstSession(page)

  // The card reads the task's own frozen intent; the session draft holds a
  // different prompt and must never leak onto it (issue #186).
  const card = page.getByTestId(`task-${frozen.id}`)
  await expect(card).toContainText('frozen-at-submit prompt')
  await expect(card).toContainText('frozen-model')
  await expect(card).toContainText('1:1')
  await expect(card).not.toContainText('夏季跑鞋主图，暖光背景')

  await page.getByTestId('composer-prompt').fill('a totally different live draft')
  await expect(card).toContainText('frozen-at-submit prompt')
  await expect(card).not.toContainText('a totally different live draft')

  // The details menu reports the same frozen facts.
  await page.getByTestId(`task-details-${frozen.id}`).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('frozen-at-submit prompt')
})

test('a task card fans its frozen reference materials', async ({ mount, page }) => {
  // The deck visual replicates on the card: session materials resolve to
  // their thumbnails, while a material deleted after submission keeps only
  // its frozen kind glyph.
  const withRefs: ScriptedTask = {
    id: 'dddddddd-0000-4000-8000-00000000rf1',
    sessionId: scriptedSessionId,
    status: 'succeeded',
    mediaType: 'image',
    slotCount: 1,
    cancelRequested: false,
    terminalCause: null,
    createdAt: '2026-09-02T09:00:00Z',
    updatedAt: '2026-09-02T09:00:01Z',
    terminalAt: '2026-09-02T09:00:01Z',
    slots: [{ index: 0, status: 'succeeded', failureReason: null, result: null }],
    specification: {
      prompt: 'reference fan prompt',
      model: 'doubao-seedream-5.0-pro',
      mode: 'reference-image',
      ratio: '1:1',
      resolution: null,
      quantity: 1,
      durationSeconds: null,
      references: [
        { materialId: 'cccccccc-0000-4000-8000-000000000003', role: 'reference', kind: 'image' },
        { materialId: 'dddddddd-0000-4000-8000-000000000004', role: 'reference', kind: 'image' },
        { materialId: 'eeeeeeee-0000-4000-8000-0000000000ff', role: 'first_frame', kind: 'video' }
      ]
    }
  }
  await mount(<CreationWorkbenchStory taskScript={{ tasks: [withRefs] }} />)
  await selectFirstSession(page)

  const pile = page.getByTestId(`task-references-${withRefs.id}`)
  await expect(pile).toBeVisible()
  await expect(pile).toHaveAttribute('aria-label', '3 reference materials')
  await expect(pile.locator('img')).toHaveCount(2)
  await expect(pile).toContainText('VID')
  // The tooltip names the material and the role it played in the freeze.
  await expect(pile.locator('[title="poster.png · Reference"]')).toHaveCount(1)
  await expect(pile.locator('[title="First frame"]')).toHaveCount(1)

  // Deleting a referenced material drops its thumbnail entry with the
  // record: the frozen pile falls back to the kind glyph instead of a
  // revoked object URL.
  await page
    .getByTestId('reference-deck')
    .getByRole('button', { name: 'poster.png', exact: true })
    .focus()
  await page.keyboard.press('Delete')
  await expect(pile.locator('img')).toHaveCount(1)
  await expect(pile).toContainText('IMG')
})

test("a terminal card's slot shape never tracks the live draft ratio", async ({ mount, page }) => {
  // Video specs freeze no ratio (the server's video branch never sets one),
  // so a cancelled video card is the widest borrowing path: its cells must
  // stay square instead of following whatever ratio the composer drafts.
  const cancelled: ScriptedTask = {
    id: 'dddddddd-0000-4000-8000-00000000cxv1',
    sessionId: scriptedSessionId,
    status: 'cancelled',
    mediaType: 'video',
    slotCount: 1,
    cancelRequested: true,
    terminalCause: null,
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt: '2026-09-01T09:00:30Z',
    terminalAt: '2026-09-01T09:00:30Z',
    slots: [{ index: 0, status: 'cancelled', failureReason: null, result: null }],
    specification: {
      prompt: 'cancelled video prompt',
      model: 'doubao-seedance-2-5',
      mode: 'omni-reference',
      ratio: null,
      resolution: '720p',
      quantity: 1,
      durationSeconds: 5,
      references: []
    }
  }
  await mount(<CreationWorkbenchStory taskScript={{ tasks: [cancelled] }} />)
  await selectFirstSession(page)

  const slot = page.getByTestId(`slot-${cancelled.id}-0`)
  await expect(slot).toHaveAttribute('data-slot-status', 'cancelled')
  await expect(slot).toHaveCSS('aspect-ratio', '1 / 1')

  await page.getByTestId('composer-params').click()
  await page.getByRole('menu').getByRole('button', { name: '9:16' }).click()
  await expect(page.getByTestId('composer-params')).toContainText('9:16')
  await expect(slot).toHaveCSS('aspect-ratio', '1 / 1')
})

test('a task whose detail carries no specification shows task-view facts only', async ({
  mount,
  page
}) => {
  const bare: ScriptedTask = {
    id: 'dddddddd-0000-4000-8000-00000000bar1',
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
  await mount(<CreationWorkbenchStory taskScript={{ tasks: [bare] }} />)
  await selectFirstSession(page)

  // Without a freeze the header keeps the task's own status and media line;
  // no prompt paragraph and no draft mirror.
  const card = page.getByTestId(`task-${bare.id}`)
  await expect(card).toBeVisible()
  await expect(card).toContainText('Generating')
  await expect(card).not.toContainText('夏季跑鞋主图，暖光背景')
  await expect(page.getByTestId(`slot-${bare.id}-0`)).toBeVisible()
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
    slots: [
      {
        index: 0,
        status: 'succeeded',
        failureReason: null,
        // The vendor's real output shape: Seedream returns JPEG, and the
        // download name must keep that format instead of forcing png.
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
  // The download keeps the provider's original format (JPEG here), named by
  // the verified result's mime instead of a fixed png extension.
  expect(calls[0].download).toBe(`nevix-${doneTask.id.slice(0, 8)}-1.jpg`)
  expect(calls[0].href).toContain('blob:')
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

test('the new-conversation row enters the composer without creating a session', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory />)
  await page.getByTestId('session-new').click()

  await expect(page.getByTestId('composer')).toBeVisible()
  await expect(page.getByTestId('workspace-hero')).toBeVisible()
  // Lazy creation: nothing reached the server and no row appeared for it.
  expect(await page.evaluate(() => window.__creationDeckTest?.createSessionCalls() ?? [])).toEqual(
    []
  )
  await expect(page.getByTestId('session-list').getByRole('listitem')).toHaveCount(2)
})

test('a composing draft submits by materializing the session first', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory />)
  await page.getByTestId('session-new').click()
  await expect(page.getByTestId('composer')).toBeVisible()
  await page.getByTestId('composer-prompt').fill('秋季上新主图')
  const submit = page.getByTestId('composer-submit')
  await expect(submit).toBeEnabled()
  await submit.click()

  // The session materialized exactly once (unnamed) and joined the list.
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.createSessionCalls() ?? []))
    .toHaveLength(1)
  expect(
    (await page.evaluate(() => window.__creationDeckTest?.createSessionCalls() ?? []))[0]?.name
  ).toBe('')
  await expect(page.getByTestId('session-list').getByRole('listitem')).toHaveCount(3)
  // The submission carried the local intent verbatim.
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? []))
    .toHaveLength(1)
  const submits = await page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? [])
  expect(submits[0]?.intent).toMatchObject({ prompt: '秋季上新主图' })
})

test('a composing draft submits after satisfying the prompt minimum', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory />)
  // Select a session first, then start composing: the composing round's own
  // defaults ride the submission once its prompt satisfies the manifest.
  await selectFirstSession(page)
  await page.getByTestId('session-new').click()
  await expect(page.getByTestId('composer')).toBeVisible()
  await page.getByTestId('composer-prompt').fill('新草稿')
  await page.getByTestId('composer-submit').click()

  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? []))
    .toHaveLength(1)
  // The composing round's draft moved under the materialized session's key.
  await expect
    .poll(
      async () => (await draftRecord(page, 'eeeeeeee-0000-4000-8000-000000000007'))?.mediaType,
      { timeout: 5_000 }
    )
    .toBe('image')
  await expect(page.getByTestId('gallery-submit-error')).toHaveCount(0)
})

test('materialization remaps every pending mention while preserving the submission contract', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory />)
  await page.getByTestId('session-new').click()
  await expect(page.getByTestId('composer')).toBeVisible()

  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByLabel('Add reference material').click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'composing.png',
    mimeType: 'image/png',
    buffer: Buffer.from('png')
  })

  // The deck card renders from its local preview; nothing has uploaded.
  await expect(
    page.getByTestId('reference-deck').getByRole('button', { name: 'composing.png', exact: true })
  ).toBeVisible()
  expect(await page.evaluate(() => window.__creationDeckTest?.uploadCalls() ?? [])).toEqual([])

  const editor = page.getByTestId('composer-prompt')
  await editor.fill('@')
  await page.keyboard.press('Enter')
  await page.keyboard.type(' and @')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Image 1' })).toHaveCount(2)
  await page.getByTestId('composer-submit').click()

  // Submission uploads the held file and re-binds the local draft with the
  // REAL id under the materialized session's key.
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.uploadCalls() ?? []))
    .toHaveLength(1)
  await expect
    .poll(async () => draftRecord(page, 'eeeeeeee-0000-4000-8000-000000000007'), {
      timeout: 5_000
    })
    .toMatchObject({
      references: [{ materialId: 'ffffffff-0000-4000-8000-000000000006', role: 'reference' }],
      promptDocument: {
        version: 1,
        nodes: [
          { type: 'mention', materialId: 'ffffffff-0000-4000-8000-000000000006' },
          { type: 'text', text: ' and ' },
          { type: 'mention', materialId: 'ffffffff-0000-4000-8000-000000000006' }
        ]
      }
    })
  const [call] = await page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? [])
  expect(call?.intent.prompt).toBe('Image 1 and Image 1')
  expect(call?.intent.references).toEqual([
    { materialId: 'ffffffff-0000-4000-8000-000000000006', role: 'reference' }
  ])
})

test('the row actions menu renames a session inline', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory />)
  const row = page
    .getByTestId('session-list')
    .getByRole('listitem')
    .filter({ hasText: 'Spring campaign' })
  await row.hover()
  await row.getByTestId(`session-menu-${scriptedSessionId}`).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()

  const input = page.getByTestId('session-rename-input')
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('Spring campaign')
  await input.fill('Summer campaign')
  await input.press('Enter')

  await expect(page.getByTestId('session-list')).toContainText('Summer campaign')
  expect(await page.evaluate(() => window.__creationDeckTest?.renameCalls() ?? [])).toEqual([
    { sessionId: scriptedSessionId, name: 'Summer campaign' }
  ])
})

test('escape cancels the inline rename without touching the server', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory />)
  const row = page
    .getByTestId('session-list')
    .getByRole('listitem')
    .filter({ hasText: 'Spring campaign' })
  await row.hover()
  await row.getByTestId(`session-menu-${scriptedSessionId}`).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()

  await page.getByTestId('session-rename-input').fill('Discarded name')
  await page.getByTestId('session-rename-input').press('Escape')

  await expect(page.getByTestId('session-list')).toContainText('Spring campaign')
  expect(await page.evaluate(() => window.__creationDeckTest?.renameCalls() ?? [])).toEqual([])
})

test('the row actions menu deletes a session', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory />)
  const row = page
    .getByTestId('session-list')
    .getByRole('listitem')
    .filter({ hasText: 'Spring campaign' })
  await row.hover()
  await row.getByTestId(`session-menu-${scriptedSessionId}`).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()

  await expect(page.getByTestId('session-list')).not.toContainText('Spring campaign')
  expect(await page.evaluate(() => window.__creationDeckTest?.deletedSessionIds() ?? [])).toEqual([
    scriptedSessionId
  ])
})
