import { expect, test } from '@playwright/experimental-ct-react'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CreationVideoWorkbenchStory as CreationWorkbenchStory } from './fixtures/creation-video.story'
import type { LocalDraftRecord } from '../../src/renderer/src/features/creation/model/draft-store'
import type { ReferenceMaterialView } from '../../src/renderer/src/features/creation/api/go-creation-http'

const sessionId = 'aaaaaaaa-0000-4000-8000-000000000001'
const draft: LocalDraftRecord = {
  prompt: 'A product turns slowly in daylight',
  promptDocument: {
    version: 1,
    nodes: [{ type: 'text', text: 'A product turns slowly in daylight' }]
  },
  mediaType: 'video',
  model: 'doubao-seedance-2-5',
  mode: 'first-last-frame',
  ratio: 'adaptive',
  resolution: '720p',
  quantity: 1,
  durationSeconds: 5,
  manifestVersion: 5,
  references: []
}

function material(
  id: string,
  kind: ReferenceMaterialView['kind'],
  fileName: string
): ReferenceMaterialView {
  return {
    id,
    kind,
    fileName,
    mimeType: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg',
    byteSize: 1024,
    widthPx: kind === 'audio' ? null : 400,
    heightPx: kind === 'audio' ? null : 400,
    pixelCount: kind === 'image' ? 160000 : null,
    durationMs: kind === 'image' ? null : 3000,
    checksumSha256: 'aa'.repeat(32),
    claimsVersion: 1,
    createdAt: '2026-08-29T10:00:00Z'
  }
}

test('video offers only the accepted two Composer choices', async ({ mount, page }) => {
  await mount(
    <CreationWorkbenchStory drafts={{ [sessionId]: draft }} materials={{ [sessionId]: [] }} />
  )
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
  await page.getByTestId('composer-mode').click()
  await expect(page.getByRole('menuitem')).toHaveCount(2)
  await expect(page.getByRole('menuitem', { name: 'First & last frame' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Omni reference' })).toBeVisible()
})

test('switching media adopts video defaults and keeps the first-frame upload entry available', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory sessions={[]} />)
  await page.getByTestId('session-new').click()
  await page.getByTestId('composer-media').click()
  await page.getByRole('menuitem', { name: 'Video generation' }).click()
  await expect(page.getByTestId('composer-mode')).toContainText('First & last frame')
  await expect(page.getByTestId('composer-params')).toContainText('720p')
  await expect(page.getByTestId('composer-duration')).toContainText('5s')
  await expect(
    page.getByRole('button', { name: 'Add reference material', exact: true })
  ).toBeEnabled()
})

for (const mode of ['text-to-video', 'omni-reference'] as const) {
  test(`a restored ${mode} draft without a ratio waits for an explicit choice`, async ({
    mount,
    page
  }) => {
    await mount(
      <CreationWorkbenchStory
        drafts={{ [sessionId]: { ...draft, mode, ratio: null } }}
        materials={{ [sessionId]: [] }}
      />
    )
    await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
    await expect(page.getByTestId('composer-prompt')).toContainText(draft.prompt)
    await expect(page.getByTestId('composer-submit')).toBeDisabled()
    await page.getByTestId('composer-params').click()
    await page.getByRole('button', { name: 'Adaptive', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('composer-submit')).toBeEnabled()
    await page.getByTestId('composer-submit').click()
    await expect
      .poll(() => page.evaluate(() => window.__creationDeckTest?.taskCalls()[0]?.intent.ratio))
      .toBe('adaptive')
  })
}

test('video duration slider uses only published choices and supports keyboard selection', async ({
  mount,
  page
}) => {
  await mount(
    <CreationWorkbenchStory drafts={{ [sessionId]: draft }} materials={{ [sessionId]: [] }} />
  )
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
  await page.getByTestId('composer-duration').click()
  const slider = page.getByRole('slider', { name: 'Duration' })
  await expect(slider).toHaveAttribute('aria-valuetext', '5s')
  await slider.focus()
  await slider.press('ArrowRight')
  await expect(slider).toHaveAttribute('aria-valuetext', '10s')
  await expect(page.getByRole('combobox', { name: 'Duration' })).toHaveValue('10')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer-duration')).toContainText('10s')
})

test('removing the chosen frames capability preserves the draft and blocks submission', async ({
  mount,
  page
}) => {
  await mount(
    <CreationWorkbenchStory
      drafts={{ [sessionId]: draft }}
      materials={{ [sessionId]: [] }}
      manifest={{
        schemaVersion: 2,
        manifestVersion: 6,
        image: { available: false, reason: 'model_unavailable', action: 'contact_admin' },
        video: {
          available: true,
          reason: null,
          action: null,
          models: [
            { model: 'doubao-seedance-2-5', resolutions: ['720p'], defaultResolution: '720p' }
          ],
          modes: [{ id: 'text-to-video', referenceMaterial: { total: { min: 0, max: 0 } } }],
          durations: [5, 10],
          ratios: ['adaptive'],
          quantities: [1],
          defaults: { ratio: 'adaptive', quantity: 1, duration: 5 },
          prompt: { minChars: 1, maxChars: 2000 }
        }
      }}
    />
  )
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
  await expect(page.getByTestId('composer-submit')).toBeDisabled()
  await expect(page.getByTestId('composer-prompt')).toContainText(draft.prompt)
  await expect(page.getByTestId('composer-mode')).toContainText('First & last frame')
})

for (const scenario of [
  { count: 0, mode: 'text-to-video', roles: [] },
  { count: 1, mode: 'first-frame', roles: ['first_frame'] },
  { count: 2, mode: 'first-last-frame', roles: ['first_frame', 'last_frame'] }
] as const) {
  test(`frames Composer submits ${scenario.mode} from actual inputs`, async ({ mount, page }) => {
    const materials = [
      material('first', 'image', 'first.png'),
      material('last', 'image', 'last.png')
    ].slice(0, scenario.count)
    const references = materials.map((entry, index) => ({
      materialId: entry.id,
      role: scenario.roles[index]
    }))
    await mount(
      <CreationWorkbenchStory
        drafts={{ [sessionId]: { ...draft, references } }}
        materials={{ [sessionId]: materials }}
      />
    )
    await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
    await expect(page.getByTestId('composer-submit')).toBeEnabled()
    await page.getByTestId('composer-submit').click()
    await expect
      .poll(() => page.evaluate(() => window.__creationDeckTest?.taskCalls()[0]?.intent ?? null))
      .toMatchObject({
        mode: scenario.mode,
        references
      })
  })
}

test('removing the first frame promotes the remaining image and submits a first-frame task', async ({
  mount,
  page
}) => {
  await mount(
    <CreationWorkbenchStory
      drafts={{
        [sessionId]: {
          ...draft,
          references: [
            { materialId: 'first', role: 'first_frame' },
            { materialId: 'last', role: 'last_frame' }
          ]
        }
      }}
      materials={{
        [sessionId]: [
          material('first', 'image', 'first.png'),
          material('last', 'image', 'last.png')
        ]
      }}
    />
  )
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
  await page.getByRole('button', { name: 'First frame · first.png', exact: true }).focus()
  await page.keyboard.press('Delete')
  await expect(
    page.getByRole('button', { name: 'First frame · last.png', exact: true })
  ).toBeVisible()
  await expect(page.getByTestId('composer-submit')).toBeEnabled()
  await page.getByTestId('composer-submit').click()
  await expect
    .poll(() => page.evaluate(() => window.__creationDeckTest?.taskCalls()[0]?.intent ?? null))
    .toMatchObject({
      mode: 'first-frame',
      references: [{ materialId: 'last', role: 'first_frame' }]
    })
})

test('omni Composer submits ordered mixed references through the common Task contract', async ({
  mount,
  page
}) => {
  const mixed = [
    material('product', 'image', 'product.png'),
    material('motion', 'video', 'motion.mp4'),
    material('sound', 'audio', 'sound.mp3')
  ]
  const references = mixed.map((entry) => ({ materialId: entry.id, role: 'omni' as const }))
  await mount(
    <CreationWorkbenchStory
      drafts={{ [sessionId]: { ...draft, mode: 'omni-reference', ratio: '16:9', references } }}
      materials={{ [sessionId]: mixed }}
    />
  )
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
  await expect(page.getByTestId('composer-mode')).toContainText('Omni reference')
  await expect(page.getByRole('button', { name: 'sound.mp3', exact: true })).toBeVisible()
  await page.getByTestId('composer-submit').click()
  await expect
    .poll(() => page.evaluate(() => window.__creationDeckTest?.taskCalls()[0]?.intent ?? null))
    .toMatchObject({
      mode: 'omni-reference',
      ratio: '16:9',
      references
    })
})

test('a verified PNG reference named product.jpg remains submittable', async ({ mount, page }) => {
  await mount(
    <CreationWorkbenchStory
      drafts={{
        [sessionId]: {
          ...draft,
          references: [{ materialId: 'product', role: 'first_frame' }]
        }
      }}
      materials={{ [sessionId]: [material('product', 'image', 'product.jpg')] }}
    />
  )
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'First frame · product.jpg', exact: true })
  ).toBeVisible()
  await expect(page.getByTestId('composer-submit')).toBeEnabled()
  await page.getByTestId('composer-submit').click()
  await expect
    .poll(() => page.evaluate(() => window.__creationDeckTest?.taskCalls()[0]?.intent.references))
    .toEqual([{ materialId: 'product', role: 'first_frame' }])
})

for (const audio of [
  { fileName: 'sound.mp3', mimeType: 'audio/mp3' },
  { fileName: 'sound.wav', mimeType: 'audio/x-wav' },
  { fileName: 'sound.wav', mimeType: 'audio/wave' },
  { fileName: 'sound.m4a', mimeType: 'audio/x-m4a' }
]) {
  test(`omni picker accepts the supported ${audio.mimeType} browser alias`, async ({
    mount,
    page
  }) => {
    await mount(
      <CreationWorkbenchStory
        drafts={{ [sessionId]: { ...draft, mode: 'omni-reference' } }}
        materials={{ [sessionId]: [] }}
      />
    )
    await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
    const chooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Add reference material', exact: true }).click()
    const chooser = await chooserPromise
    await chooser.setFiles({
      name: audio.fileName,
      mimeType: audio.mimeType,
      buffer: Buffer.from('audio fixture')
    })
    await expect(page.getByRole('button', { name: audio.fileName, exact: true })).toBeVisible()
    await expect(page.getByTestId('composer-submit')).toBeEnabled()
    await page.getByTestId('composer-submit').click()
    await expect
      .poll(() => page.evaluate(() => window.__creationDeckTest?.taskCalls()[0]?.intent ?? null))
      .toMatchObject({
        mode: 'omni-reference',
        references: [{ materialId: 'ffffffff-0000-4000-8000-000000000006', role: 'omni' }]
      })
  })
}

for (const invalid of [
  {
    label: 'media MIME',
    materials: [{ ...material('a', 'image', 'a.png'), mimeType: 'image/gif' }]
  },
  {
    label: 'per-media reference count',
    materials: [material('a', 'video', 'a.mp4'), material('b', 'video', 'b.mp4')]
  },
  {
    label: 'video duration',
    materials: [{ ...material('a', 'video', 'a.mp4'), durationMs: 30001 }]
  },
  {
    label: 'audio duration',
    materials: [{ ...material('a', 'audio', 'a.mp3'), durationMs: 1999 }]
  },
  {
    label: 'video image byte limit',
    materials: [{ ...material('a', 'image', 'a.png'), byteSize: 10 * 1024 * 1024 + 1 }]
  }
]) {
  test(`omni keeps an invalid ${invalid.label} visible and blocks submission`, async ({
    mount,
    page
  }) => {
    const references = invalid.materials.map((entry) => ({
      materialId: entry.id,
      role: 'omni' as const
    }))
    await mount(
      <CreationWorkbenchStory
        drafts={{ [sessionId]: { ...draft, mode: 'omni-reference', references } }}
        materials={{ [sessionId]: invalid.materials }}
      />
    )
    await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
    await expect(page.getByTestId('composer-deck-stale')).toBeVisible()
    await expect(page.getByTestId('composer-submit')).toBeDisabled()
    await expect(page.getByTestId('reference-deck').locator('[data-material-id]')).toHaveCount(
      invalid.materials.length
    )
  })
}

test('frame mode preserves a nonadaptive ratio until the creator explicitly fixes it', async ({
  mount,
  page
}) => {
  await mount(
    <CreationWorkbenchStory
      drafts={{
        [sessionId]: {
          ...draft,
          ratio: '16:9',
          references: [{ materialId: 'first', role: 'first_frame' }]
        }
      }}
      materials={{ [sessionId]: [material('first', 'image', 'first.png')] }}
    />
  )
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
  await expect(page.getByTestId('composer-submit')).toBeDisabled()
  await page.getByTestId('composer-params').click()
  await expect(page.getByRole('note').filter({ hasText: '16:9' })).toBeVisible()
  await page.getByRole('button', { name: 'Adaptive', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('composer-submit')).toBeEnabled()
  await expect(page.getByTestId('composer-params')).toContainText('Adaptive')
  await page.evaluate(() => window.__creationDeckTest?.changeLanguage('zh-CN'))
  await expect(page.getByTestId('composer-params')).toContainText('自适应')
  await page.getByTestId('composer-submit').click()
  await expect
    .poll(() => page.evaluate(() => window.__creationDeckTest?.taskCalls()[0]?.intent.ratio))
    .toBe('adaptive')
})

for (const viewport of [
  { width: 960, height: 600 },
  { width: 1280, height: 800 }
]) {
  test(`video controls and mixed deck remain usable at ${viewport.width}×${viewport.height}`, async ({
    mount,
    page
  }, testInfo) => {
    await page.setViewportSize(viewport)
    const mixed = [
      material('product', 'image', 'product.png'),
      material('motion', 'video', 'motion.mp4'),
      material('sound', 'audio', 'sound.mp3')
    ]
    await mount(
      <CreationWorkbenchStory
        height={viewport.height}
        drafts={{
          [sessionId]: {
            ...draft,
            mode: 'omni-reference',
            references: mixed.map((entry) => ({ materialId: entry.id, role: 'omni' }))
          }
        }}
        materials={{ [sessionId]: mixed }}
      />
    )
    await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()
    await page.getByRole('button', { name: 'sound.mp3', exact: true }).focus()
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByRole('button', { name: 'motion.mp4', exact: true })).toBeFocused()
    await expect
      .poll(async () => {
        const first = await page
          .getByRole('button', { name: 'product.png', exact: true })
          .boundingBox()
        const last = await page
          .getByRole('button', { name: 'sound.mp3', exact: true })
          .boundingBox()
        return last!.x - first!.x
      })
      .toBeGreaterThan(60)
    const screenshotDirectory = resolve(
      testInfo.config.rootDir,
      '../../../../.scratch/issue-161-video/ui'
    )
    await mkdir(screenshotDirectory, { recursive: true })
    const deckPath = resolve(screenshotDirectory, `video-deck-${viewport.width}.png`)
    await page.screenshot({ path: deckPath })
    await testInfo.attach(`video-deck-${viewport.width}`, {
      path: deckPath,
      contentType: 'image/png'
    })
    await page.getByTestId('composer-duration').click()
    await expect(page.getByRole('slider', { name: 'Duration' })).toBeVisible()
    const durationMenu = page
      .getByRole('slider', { name: 'Duration' })
      .locator('..')
      .locator('..')
      .locator('..')
    const rect = await durationMenu.boundingBox()
    expect(rect!.x).toBeGreaterThanOrEqual(0)
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width)
    expect(rect!.y).toBeGreaterThanOrEqual(0)
    const durationPath = resolve(screenshotDirectory, `video-duration-${viewport.width}.png`)
    await page.screenshot({ path: durationPath })
    await testInfo.attach(`video-duration-${viewport.width}`, {
      path: durationPath,
      contentType: 'image/png'
    })
    await page.keyboard.press('Escape')
    await page.getByTestId('composer-params').click()
    await expect(page.getByRole('button', { name: '1080p', exact: true })).toBeVisible()
    const paramsPath = resolve(screenshotDirectory, `video-params-${viewport.width}.png`)
    await page.screenshot({ path: paramsPath })
    await testInfo.attach(`video-params-${viewport.width}`, {
      path: paramsPath,
      contentType: 'image/png'
    })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'sound.mp3', exact: true }).focus()
    await page.keyboard.press('Delete')
    await page.getByRole('button', { name: 'motion.mp4', exact: true }).focus()
    await page.keyboard.press('Delete')
    await page.getByTestId('composer-mode').click()
    await page.getByRole('menuitem', { name: 'First & last frame' }).click()
    await expect(
      page.getByRole('button', { name: 'First frame · product.png', exact: true })
    ).toBeVisible()
    const framesPath = resolve(screenshotDirectory, `video-frames-${viewport.width}.png`)
    await page.screenshot({ path: framesPath })
    await testInfo.attach(`video-frames-${viewport.width}`, {
      path: framesPath,
      contentType: 'image/png'
    })
  })
}
