import { expect, test, type Page } from '@playwright/experimental-ct-react'
import { CreationWorkbenchStory } from './fixtures/creation-workbench.story'
import type { LocalDraftRecord } from '../src/renderer/src/features/creation/model/draft-store'

/**
 * Drop-surface tests for the reference deck (issue #177 drag-drop follow-up):
 * external files append through the ordinary upload path, a mixed batch
 * reports its rejected remainder, a single file on one card swaps it in
 * place, a mentioned card refuses replacement, and a dragged slot result
 * re-uploads under its download-twin name (ADR-0018) — while a kind-denied
 * result is refused at the surface, before any bytes stream. Drops are
 * dispatched as real DataTransfer events; only visible UI and the story's
 * port-call handle are asserted.
 */

const scriptedSessionId = 'aaaaaaaa-0000-4000-8000-000000000001'
const firstMaterialId = 'cccccccc-0000-4000-8000-000000000003'

interface DroppedFile {
  readonly name: string
  readonly type: string
}

/** Dispatches a native drop carrying the given files (plus an optional
 * string payload) on the first element matching the selector. */
async function dropOn(
  page: Page,
  selector: string,
  files: readonly DroppedFile[],
  extra?: { readonly type: string; readonly data: string }
): Promise<void> {
  await page.evaluate(
    ({ selector, files, extra }) => {
      const target = document.querySelector(selector)
      if (target === null) throw new Error(`no element for ${selector}`)
      const dataTransfer = new DataTransfer()
      for (const file of files) {
        dataTransfer.items.add(
          new File([new Uint8Array([137, 80, 78, 71])], file.name, { type: file.type })
        )
      }
      if (extra !== undefined) dataTransfer.setData(extra.type, extra.data)
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
    },
    { selector, files, extra }
  )
}

function uploadCalls(page: Page): Promise<ReadonlyArray<{ sessionId: string; name: string }>> {
  return page.evaluate(() => window.__creationDeckTest?.uploadCalls() ?? [])
}

function resultBlobTransfers(
  page: Page
): Promise<ReadonlyArray<{ taskId: string; slotIndex: number }>> {
  return page.evaluate(() => window.__creationDeckTest?.resultBlobTransfers() ?? [])
}

/** Lets queued render effects flush, so a negative transfer assertion cannot
 * race a pending re-fetch. */
async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))))
}

function deleteMaterialCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__creationDeckTest?.deleteMaterialCalls() ?? [])
}

async function selectFirstSession(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
  await expect(page.getByTestId('composer')).toBeVisible()
}

/** Samples every deck card's img src each frame, keyed by file name (stable
 * across the identity swap): a painted card whose src ever changes is a
 * visible reload flash, whatever the cause. */
async function installSrcSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const samples = new Map<string, Set<string>>()
    ;(window as { __srcSamples?: Map<string, Set<string>> }).__srcSamples = samples
    const sample = (): void => {
      for (const card of document.querySelectorAll<HTMLElement>(
        '[data-testid="deck-strip"] [data-material-id]'
      )) {
        const label = card.querySelector('button[aria-label]')?.getAttribute('aria-label')
        const src = card.querySelector('img')?.src
        if (label === undefined || src === undefined) continue
        const seen = samples.get(label) ?? new Set<string>()
        seen.add(src)
        samples.set(label, seen)
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
}

function srcSamples(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...((window as { __srcSamples?: Map<string, Set<string>> }).__srcSamples ?? [])].map(
        ([label, srcs]) => [label, [...srcs]]
      )
    )
  )
}

test('a file dropped on the deck appends through the ordinary upload path', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  const cards = page.locator('[data-testid="deck-strip"] [data-material-id]')
  await expect(cards).toHaveCount(2)

  await dropOn(page, '[data-testid="reference-deck"]', [{ name: 'photo.png', type: 'image/png' }])

  await expect.poll(() => uploadCalls(page)).toHaveLength(1)
  expect((await uploadCalls(page))[0]?.name).toBe('photo.png')
  await expect(cards).toHaveCount(3)
  await expect(page.getByTestId('composer-drop-rejected')).toHaveCount(0)
})

test('the first card on an empty deck never re-mounts: one card node across the upload resolution', async ({
  mount,
  page
}) => {
  const emptyDeckDraft: LocalDraftRecord = {
    prompt: 'Fresh',
    promptDocument: { version: 1, nodes: [{ type: 'text', text: 'Fresh' }] },
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
  await mount(
    <CreationWorkbenchStory drafts={{ [scriptedSessionId]: emptyDeckDraft }} uploadDeferred />
  )
  await selectFirstSession(page)
  await expect(page.getByTestId('deck-strip')).toHaveCount(0)

  // Counts every card mount; MutationObserver reports only subtree roots,
  // so cards riding inside a fresh subtree are tagged by walking it. A
  // remount restarts fade-in-0 from invisible: the visible blink.
  await page.evaluate(() => {
    const deck = document.querySelector('[data-testid="reference-deck"]')
    if (deck === null) throw new Error('no deck')
    const tag = (node: Node): void => {
      if (!(node instanceof HTMLElement)) return
      const cards = [
        ...(node.matches('[data-material-id]') ? [node] : []),
        ...node.querySelectorAll<HTMLElement>('[data-material-id]')
      ]
      for (const card of cards) {
        if (card.dataset.cardMount === 'seen') continue
        card.dataset.cardMount = 'seen'
        const w = window as { __cardMountCount?: number }
        w.__cardMountCount = (w.__cardMountCount ?? 0) + 1
      }
    }
    const observer = new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach(tag)
    })
    observer.observe(deck, { childList: true, subtree: true })
  })

  await dropOn(page, '[data-testid="reference-deck"]', [{ name: 'photo.png', type: 'image/png' }])
  await expect.poll(() => uploadCalls(page)).toHaveLength(1)

  // While the upload is in flight the pending card already paints; the img
  // element is the painted-vs-glyph signal (the CSS-less spec gives a broken
  // fixture no box, so visibility is unusable here).
  const card = page.locator('[data-testid="deck-strip"] [data-material-id]')
  await expect(card).toHaveCount(1)
  await expect(card.locator('img')).toHaveCount(1)
  expect(await card.getAttribute('data-material-id')).not.toBe(
    'ffffffff-0000-4000-8000-000000000006'
  )
  await settleFrames(page)

  await page.evaluate(() => window.__creationDeckTest?.releaseUploads())
  // Polling the reconciled identity means the swap, if any, has happened.
  await expect
    .poll(() =>
      page.evaluate(() =>
        document
          .querySelector('[data-testid="deck-strip"] [data-material-id]')
          ?.getAttribute('data-material-id')
      )
    )
    .toBe('ffffffff-0000-4000-8000-000000000006')
  await settleFrames(page)

  const mounts = await page.evaluate(
    () => (window as { __cardMountCount?: number }).__cardMountCount ?? 0
  )
  expect(mounts).toBe(1)
  await expect(card.locator('img')).toHaveCount(1)
})

test('a still-uploading card keeps its painted preview while a sibling upload resolves', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory uploadDeferred />)
  await selectFirstSession(page)
  await expect(page.locator('[data-testid="deck-strip"] [data-material-id]')).toHaveCount(2)

  const cardId = (name: string): Promise<string | null> =>
    page
      .locator(`[data-testid="deck-strip"] [aria-label="${name}"]`)
      .evaluate((button) =>
        button.closest<HTMLElement>('[data-material-id]')?.getAttribute('data-material-id')
      )

  await installSrcSampler(page)

  await dropOn(page, '[data-testid="reference-deck"]', [{ name: 'a.png', type: 'image/png' }])
  await expect.poll(() => uploadCalls(page)).toHaveLength(1)
  await dropOn(page, '[data-testid="reference-deck"]', [{ name: 'b.png', type: 'image/png' }])
  await expect.poll(() => uploadCalls(page)).toHaveLength(2)
  await settleFrames(page)

  // a.png resolves; the restore re-registers the still-staged b.png.
  await page.evaluate(() => window.__creationDeckTest?.releaseNextUpload())
  await expect.poll(() => cardId('a.png')).toBe('ffffffff-0000-4000-8000-000000000006')

  await page.evaluate(() => window.__creationDeckTest?.releaseUploads())
  await expect.poll(() => cardId('b.png')).toBe('ffffffff-0000-4000-8000-000000000007')
  await settleFrames(page)
  await expect(page.locator('[data-testid="deck-strip"] img')).toHaveCount(4)

  // No painted card ever swapped its src, at any lifecycle point.
  const samples = await srcSamples(page)
  for (const [label, srcs] of Object.entries(samples)) {
    expect(srcs, `${label} flashed through ${srcs?.length} URLs`).toHaveLength(1)
  }
})

test('a mixed batch adds the admissible file and reports the rejected remainder', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  await dropOn(page, '[data-testid="reference-deck"]', [
    { name: 'photo.png', type: 'image/png' },
    { name: 'brief.pdf', type: 'application/pdf' }
  ])

  await expect.poll(() => uploadCalls(page)).toHaveLength(1)
  expect((await uploadCalls(page))[0]?.name).toBe('photo.png')
  await expect(page.getByTestId('composer-drop-rejected')).toContainText('Added 1')
  await expect(page.getByTestId('composer-drop-rejected')).toContainText('rejected 1')
})

test('a wholly inadmissible batch is rejected without any upload', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  await dropOn(page, '[data-testid="reference-deck"]', [
    { name: 'brief.pdf', type: 'application/pdf' }
  ])

  await expect(page.getByTestId('composer-drop-rejected')).toContainText('Added 0')
  await expect.poll(() => uploadCalls(page), { timeout: 500 }).toHaveLength(0)
})

test('a single file dropped on one card replaces it in place', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)
  await installSrcSampler(page)

  const cards = page.locator('[data-testid="deck-strip"] [data-material-id]')
  await expect(cards).toHaveCount(2)

  await dropOn(page, `[data-material-id="${firstMaterialId}"]`, [
    { name: 'swap.png', type: 'image/png' }
  ])

  // Replace = upload the new card, then delete the old one; deck size holds.
  await expect.poll(() => uploadCalls(page)).toHaveLength(1)
  expect((await uploadCalls(page))[0]?.name).toBe('swap.png')
  await expect.poll(() => deleteMaterialCalls(page)).toEqual([firstMaterialId])
  await expect(cards).toHaveCount(2)
  const swapped = page.locator('[data-testid="deck-strip"] [aria-label="swap.png"]')
  await expect(swapped).toHaveCount(1)
  await settleFrames(page)

  // The swapped-in card carries its preview: no src change, no blob refetch
  // for its server id; the untouched sibling never reloads.
  const samples = await srcSamples(page)
  expect(samples['swap.png']).toHaveLength(1)
  expect(samples['banner.png']).toHaveLength(1)
  const blobCalls = await page.evaluate(() => window.__creationDeckTest?.materialBlobCalls() ?? [])
  expect(
    blobCalls.some((call) => call.materialId === 'ffffffff-0000-4000-8000-000000000006'),
    'the replacement preview must carry; a fetch here means a glyph phase'
  ).toBe(false)
})

test('a card the prompt still mentions never gets replaced; the drop appends', async ({
  mount,
  page
}) => {
  const mentionDraft: LocalDraftRecord = {
    prompt: 'Image 1',
    promptDocument: { version: 1, nodes: [{ type: 'mention', materialId: firstMaterialId }] },
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
  await mount(<CreationWorkbenchStory drafts={{ [scriptedSessionId]: mentionDraft }} />)
  await selectFirstSession(page)

  const cards = page.locator('[data-testid="deck-strip"] [data-material-id]')
  await expect(cards).toHaveCount(1)

  await dropOn(page, `[data-material-id="${firstMaterialId}"]`, [
    { name: 'swap.png', type: 'image/png' }
  ])

  await expect.poll(() => uploadCalls(page)).toHaveLength(1)
  await expect.poll(() => deleteMaterialCalls(page), { timeout: 500 }).toHaveLength(0)
  await expect(cards).toHaveCount(2)
})

test('the fan lays cards out oldest-to-newest, so a later drop joins the right end', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  const deck = page.getByTestId('reference-deck')
  await deck.hover()
  await expect(page.getByTestId('deck-strip')).toBeVisible()

  // The authored transform (not the computed one) reads immediately, so the
  // 200ms pose transition cannot race the assertion.
  const fanX = (name: string): Promise<number> =>
    deck.getByRole('button', { name, exact: true }).evaluate((button) => {
      const card = button.closest<HTMLElement>('[data-material-id]')
      const translate = card?.style.transform.match(/translate\((-?[\d.]+)px/)
      return translate === undefined || translate === null ? Number.NaN : Number(translate[1])
    })

  expect(await fanX('poster.png')).toBe(0)
  expect(await fanX('banner.png')).toBeGreaterThan(0)

  await dropOn(page, '[data-testid="reference-deck"]', [{ name: 'photo.png', type: 'image/png' }])
  await expect(page.locator('[data-testid="deck-strip"] [data-material-id]')).toHaveCount(3)

  const posterX = await fanX('poster.png')
  const bannerX = await fanX('banner.png')
  const photoX = await fanX('photo.png')
  expect(photoX).toBeGreaterThan(bannerX)
  expect(bannerX).toBeGreaterThan(posterX)
  // Even pitch: the newcomer takes the next slot, existing cards stay put.
  expect(bannerX - posterX).toBe(photoX - bannerX)
})

test('a dragged slot result re-uploads as a material under its download name', async ({
  mount,
  page
}) => {
  const taskId = 'eeeeeeee-0000-4000-8000-00000000000e'
  await mount(
    <CreationWorkbenchStory
      taskScript={{
        tasks: [
          {
            id: taskId,
            sessionId: scriptedSessionId,
            status: 'succeeded',
            mediaType: 'image',
            slotCount: 1,
            snapshot: null,
            cancelRequested: false,
            terminalCause: null,
            terminalAt: null,
            createdAt: '2026-08-23T08:00:00Z',
            updatedAt: '2026-08-23T08:00:05Z',
            slots: [
              {
                index: 0,
                status: 'succeeded',
                failureReason: null,
                result: {
                  mimeType: 'image/png',
                  byteSize: 64,
                  checksumSha256: 'bb'.repeat(32),
                  widthPx: 48,
                  heightPx: 64,
                  durationMs: null
                }
              }
            ]
          }
        ]
      }}
    />
  )
  await selectFirstSession(page)

  await dropOn(page, '[data-testid="reference-deck"]', [], {
    type: 'application/x-nevix-creation-result',
    data: JSON.stringify({ taskId, slotIndex: 0, mediaType: 'image' })
  })

  await expect.poll(() => uploadCalls(page)).toHaveLength(1)
  const uploads = await uploadCalls(page)
  expect(uploads[0]?.name).toMatch(/^nevix-eeeeeeee-1\./)
  await expect(page.locator('[data-testid="deck-strip"] [data-material-id]')).toHaveCount(3)
})

test('a kind-denied slot result is refused before any bytes stream', async ({ mount, page }) => {
  // The image-only deck denies the video payload at the drop surface, so
  // the ADR-0018 re-upload path (and its blob fetch) never starts; a fetch
  // would be followed by an upload, making uploadCalls the observable.
  await mount(<CreationWorkbenchStory />)
  await selectFirstSession(page)

  const cards = page.locator('[data-testid="deck-strip"] [data-material-id]')
  await expect(cards).toHaveCount(2)

  await dropOn(page, '[data-testid="reference-deck"]', [], {
    type: 'application/x-nevix-creation-result',
    data: JSON.stringify({
      taskId: 'eeeeeeee-0000-4000-8000-00000000000f',
      slotIndex: 0,
      mediaType: 'video'
    })
  })

  await expect.poll(() => uploadCalls(page), { timeout: 500 }).toHaveLength(0)
  await expect(cards).toHaveCount(2)
  await expect(page.getByTestId('composer-drop-rejected')).toHaveCount(0)
})

test('a dragged slot result re-uploads without fetching its object URL (renderer CSP forbids blob: fetches)', async ({
  mount,
  page
}) => {
  // Mirror the renderer CSP (blob: is display-only — renderer-csp.ts): make
  // fetch(blob:) reject here as it does in production, so the re-upload path
  // proves it takes bytes through its port, never an object-URL fetch.
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith('blob:')) return Promise.reject(new TypeError('Failed to fetch'))
      return originalFetch(input, init)
    }
  })

  const taskId = 'eeeeeeee-0000-4000-8000-00000000000e'
  await mount(
    <CreationWorkbenchStory
      taskScript={{
        tasks: [
          {
            id: taskId,
            sessionId: scriptedSessionId,
            status: 'succeeded',
            mediaType: 'image',
            slotCount: 1,
            snapshot: null,
            cancelRequested: false,
            terminalCause: null,
            terminalAt: null,
            createdAt: '2026-08-23T08:00:00Z',
            updatedAt: '2026-08-23T08:00:05Z',
            slots: [
              {
                index: 0,
                status: 'succeeded',
                failureReason: null,
                result: {
                  mimeType: 'image/svg+xml',
                  byteSize: 64,
                  checksumSha256: 'bb'.repeat(32),
                  widthPx: 48,
                  heightPx: 64,
                  durationMs: null
                }
              }
            ]
          }
        ]
      }}
    />
  )
  await selectFirstSession(page)

  await dropOn(page, '[data-testid="reference-deck"]', [], {
    type: 'application/x-nevix-creation-result',
    data: JSON.stringify({ taskId, slotIndex: 0, mediaType: 'image' })
  })

  await expect.poll(() => uploadCalls(page)).toHaveLength(1)
  await expect(page.getByTestId('composer-upload-failed')).toHaveCount(0)
})

test('editing the deck does not re-transfer an already-rendered slot result', async ({
  mount,
  page
}) => {
  const taskId = 'eeeeeeee-0000-4000-8000-00000000000f'
  await mount(
    <CreationWorkbenchStory
      taskScript={{
        tasks: [
          {
            id: taskId,
            sessionId: scriptedSessionId,
            status: 'succeeded',
            mediaType: 'image',
            slotCount: 1,
            snapshot: null,
            cancelRequested: false,
            terminalCause: null,
            terminalAt: null,
            createdAt: '2026-08-23T08:00:00Z',
            updatedAt: '2026-08-23T08:00:05Z',
            slots: [
              {
                index: 0,
                status: 'succeeded',
                failureReason: null,
                result: {
                  mimeType: 'image/png',
                  byteSize: 64,
                  checksumSha256: 'bb'.repeat(32),
                  widthPx: 48,
                  heightPx: 64,
                  durationMs: null
                }
              }
            ]
          }
        ]
      }}
    />
  )
  await selectFirstSession(page)

  // The verified bytes cross the data plane exactly once, when the slot
  // first renders.
  await expect(page.getByTestId(`slot-${taskId}-0`).locator('img')).toBeVisible()
  expect(await resultBlobTransfers(page)).toHaveLength(1)

  // A deck edit re-renders the whole workbench; the gallery must keep riding
  // that first transfer instead of downloading the result again.
  await dropOn(page, '[data-testid="reference-deck"]', [{ name: 'photo.png', type: 'image/png' }])
  await expect(page.locator('[data-testid="deck-strip"] [data-material-id]')).toHaveCount(3)
  await settleFrames(page)

  expect(await resultBlobTransfers(page)).toHaveLength(1)
})
