import { expect, test, type Page } from '@playwright/experimental-ct-react'
import {
  CreationWorkbenchRestartStory,
  CreationWorkbenchNavigationStory,
  CreationWorkbenchStory,
  type ScriptedTask
} from './fixtures/creation-workbench.story'
import type { LocalDraftRecord } from '../src/renderer/src/features/creation/model/draft-store'

const acceptedTaskId = 'dddddddd-0000-4000-8000-000000000004'
const firstMaterialId = 'cccccccc-0000-4000-8000-000000000003'
const secondMaterialId = 'dddddddd-0000-4000-8000-000000000004'
const uploadedMaterialId = 'ffffffff-0000-4000-8000-000000000006'

async function selectSession(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click()
}

async function replaceByDrop(page: Page, materialId: string, name: string): Promise<void> {
  await page.evaluate(
    ({ materialId, name }) => {
      const target = document.querySelector(`[data-material-id="${materialId}"]`)
      if (target === null) throw new Error(`missing material ${materialId}`)
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(new File(['png'], name, { type: 'image/png' }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
    },
    { materialId, name }
  )
}

async function selectMedia(
  page: Page,
  name: 'Image generation' | 'Video generation'
): Promise<void> {
  await page.getByTestId('composer-media').click()
  await page.getByRole('menuitem', { name }).click()
}

test('both media drafts and the selected editor survive navigation and app restart', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchRestartStory />)
  await selectSession(page, 'Spring campaign')
  await page.getByTestId('composer-prompt').fill('image version')
  await selectMedia(page, 'Video generation')
  await page.getByTestId('composer-prompt').fill('video version')

  await selectSession(page, 'Untitled creation')
  await selectSession(page, 'Spring campaign')
  await expect(page.getByTestId('composer-media')).toContainText('Video generation')
  await expect(page.getByTestId('composer-prompt')).toHaveText('video version')

  await page.getByRole('button', { name: 'Restart app' }).click()
  await selectSession(page, 'Spring campaign')
  await expect(page.getByTestId('composer-media')).toContainText('Video generation')
  await expect(page.getByTestId('composer-prompt')).toHaveText('video version')
  await selectMedia(page, 'Image generation')
  await expect(page.getByTestId('composer-prompt')).toHaveText('image version')
})

test('an upload finishing after a media switch updates its source draft', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory uploadDeferred />)
  await selectSession(page, 'Spring campaign')
  await selectMedia(page, 'Video generation')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByLabel('Add reference material').click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'video-frame.png',
    mimeType: 'image/png',
    buffer: Buffer.from('png')
  })
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.uploadCalls() ?? []))
    .toHaveLength(1)
  await selectMedia(page, 'Image generation')
  await expect(page.getByRole('button', { name: /video-frame\.png/ })).toHaveCount(0)

  await page.evaluate(() => window.__creationDeckTest?.releaseUploads())
  await expect(page.getByRole('button', { name: /video-frame\.png/ })).toHaveCount(0)
  await selectMedia(page, 'Video generation')
  await expect(page.getByRole('button', { name: /First frame.*video-frame\.png/ })).toBeVisible()
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__creationDeckTest?.draftRecord('aaaaaaaa-0000-4000-8000-000000000001')
            ?.references ?? []
      )
    )
    .toEqual([{ materialId: uploadedMaterialId, role: 'first_frame' }])
})

test('a replacement finishing after a media switch leaves the other draft alone', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory uploadDeferred />)
  await selectSession(page, 'Spring campaign')
  await replaceByDrop(page, firstMaterialId, 'replacement.png')
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.uploadCalls() ?? []))
    .toHaveLength(1)
  await selectMedia(page, 'Video generation')
  await page.getByTestId('composer-prompt').fill('video remains separate')

  await page.evaluate(() => window.__creationDeckTest?.releaseUploads())
  await expect(page.getByTestId('composer-prompt')).toHaveText('video remains separate')
  await expect(page.getByRole('button', { name: /replacement\.png/ })).toHaveCount(0)
  await selectMedia(page, 'Image generation')
  await expect(page.getByRole('button', { name: 'replacement.png', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'poster.png', exact: true })).toHaveCount(0)
})

test('an upload failure after switching media appears only in its source draft', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory uploadDeferred uploadOutcome="request-rejected" />)
  await selectSession(page, 'Spring campaign')
  await selectMedia(page, 'Video generation')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByLabel('Add reference material').click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'failed-frame.png',
    mimeType: 'image/png',
    buffer: Buffer.from('png')
  })
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.uploadCalls() ?? []))
    .toHaveLength(1)
  await selectMedia(page, 'Image generation')
  await page.evaluate(() => window.__creationDeckTest?.releaseUploads())
  await expect(page.getByTestId('gallery-submit-error')).toHaveCount(0)
  await selectMedia(page, 'Video generation')
  await expect(page.getByTestId('gallery-submit-error')).toContainText('material_too_large')
  await page.getByTestId('session-new').click()
  await selectSession(page, 'Spring campaign')
  await expect(page.getByTestId('composer-media')).toContainText('Video generation')
  await expect(page.getByTestId('gallery-submit-error')).toContainText('material_too_large')
})

test('an existing-session submission continues while Settings unmounts the workbench', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchNavigationStory taskScript={{ submitDeferred: true }} />)
  await selectSession(page, 'Spring campaign')
  await expect(page.getByTestId('composer')).toBeVisible()

  await page.getByTestId('composer-submit').click()
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? []))
    .toHaveLength(1)
  await page.getByRole('button', { name: 'Open settings' }).click()
  await expect(page.getByTestId('settings-surface')).toBeVisible()

  await page.evaluate(() => window.__creationDeckTest?.releaseSubmissions())
  await page.getByRole('button', { name: 'Back to creation' }).click()
  await expect(page.getByTestId('composer')).toBeVisible()
  await expect(page.getByTestId(`task-${acceptedTaskId}`)).toBeVisible()
})

test('the global session navigation opens the selected session from Settings', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchNavigationStory />)
  await page.getByRole('button', { name: 'Open settings' }).click()

  await expect(page.getByTestId('creation-session-navigation')).toBeVisible()
  await page.getByRole('button', { name: 'Spring campaign', exact: true }).click()

  await expect(page.getByTestId('settings-surface')).toHaveCount(0)
  await expect(page.getByTestId('composer')).toBeVisible()
})

test('a recreated navigation provider starts with no selected Workbench Context', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchRestartStory />)
  await selectSession(page, 'Spring campaign')
  await expect(page.getByTestId('composer')).toBeVisible()

  await page.getByRole('button', { name: 'Restart app' }).click()

  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByLabel('Workspace')).toContainText(
    'Pick or create a session to start your work'
  )
})

test('an unbound reference stays out of the Draft after session switch and restart', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchRestartStory />)
  await selectSession(page, 'Spring campaign')
  const poster = page.getByRole('button', { name: 'poster.png', exact: true })
  await poster.focus()
  await page.keyboard.press('Delete')
  await expect(poster).toHaveCount(0)
  expect(
    await page.evaluate(() =>
      window.__creationDeckTest?.materialIds('aaaaaaaa-0000-4000-8000-000000000001')
    )
  ).toContain(firstMaterialId)

  await selectSession(page, 'Untitled creation')
  await selectSession(page, 'Spring campaign')
  await expect(poster).toHaveCount(0)
  await page.getByRole('button', { name: 'Restart app' }).click()
  await selectSession(page, 'Spring campaign')
  await expect(poster).toHaveCount(0)
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__creationDeckTest?.draftRecord('aaaaaaaa-0000-4000-8000-000000000001')
            ?.references ?? []
      )
    )
    .toEqual([{ materialId: secondMaterialId, role: 'reference' }])
})

test('an accepted response loss resumes the exact frozen submission', async ({ mount, page }) => {
  await mount(
    <CreationWorkbenchStory taskScript={{ submitOutcomes: ['accepted-response-lost'] }} />
  )
  await selectSession(page, 'Spring campaign')
  await expect(page.getByTestId('composer')).toBeVisible()

  await page.getByTestId('composer-submit').click()
  await expect(page.getByTestId('creation-action-notice')).toContainText(
    'The submission outcome could not be confirmed'
  )
  await page.getByTestId('composer-prompt').fill('An edit after the click')
  await page.getByTestId('creation-resume-submission').click()

  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? []))
    .toHaveLength(2)
  const calls = await page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? [])
  expect(calls[1]).toEqual(calls[0])
  expect(calls[0]?.intent.prompt).not.toBe('An edit after the click')
  await expect(page.getByTestId(`task-${acceptedTaskId}`)).toBeVisible()
  await expect(page.getByTestId('creation-action-notice')).toHaveCount(0)
})

test('submission freezes mention language and reference order before an upload settles', async ({
  mount,
  page
}) => {
  const draft: LocalDraftRecord = {
    prompt: 'Image 1',
    promptDocument: {
      version: 1,
      nodes: [{ type: 'mention', materialId: firstMaterialId }]
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
  await mount(
    <CreationWorkbenchStory
      uploadDeferred
      drafts={{ 'aaaaaaaa-0000-4000-8000-000000000001': draft }}
    />
  )
  await selectSession(page, 'Spring campaign')

  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByLabel('Add reference material').click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'waiting.png',
    mimeType: 'image/png',
    buffer: Buffer.from('png')
  })
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.uploadCalls() ?? []))
    .toHaveLength(1)

  await page.getByTestId('composer-submit').click()
  await expect(page.getByTestId('creation-action-notice')).toContainText(
    'The action is continuing in the background'
  )
  await page.evaluate(async () => window.__creationDeckTest?.changeLanguage('zh-CN'))
  await page.evaluate(() => window.__creationDeckTest?.releaseUploads())

  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? []))
    .toHaveLength(1)
  const [call] = await page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? [])
  expect(call?.intent.prompt).toBe('Image 1')
  expect(call?.intent.references).toEqual([
    { materialId: firstMaterialId, role: 'reference' },
    { materialId: uploadedMaterialId, role: 'reference' }
  ])
})

test('an existing-session upload continues across navigation and returns as a Go fact', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchNavigationStory uploadDeferred />)
  await selectSession(page, 'Spring campaign')
  await expect(page.getByTestId('composer')).toBeVisible()

  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByLabel('Add reference material').click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'navigation.png',
    mimeType: 'image/png',
    buffer: Buffer.from('png')
  })
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.uploadCalls() ?? []))
    .toHaveLength(1)

  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.evaluate(() => window.__creationDeckTest?.releaseUploads())
  await page.getByRole('button', { name: 'Back to creation' }).click()
  await expect(page.getByTestId('composer')).toBeVisible()
  await expect(page.getByRole('button', { name: 'navigation.png', exact: true })).toBeVisible()
})

test('dismissing a confirmed material failure keeps it dismissed after reconcile', async ({
  mount,
  page
}) => {
  await mount(
    <CreationWorkbenchStory
      uploadOutcome="request-rejected"
      drafts={{
        'aaaaaaaa-0000-4000-8000-000000000001': {
          prompt: '',
          promptDocument: { version: 1, nodes: [{ type: 'text', text: '' }] },
          mediaType: 'image',
          manifestVersion: 5,
          model: 'doubao-seedream-5.0-pro',
          mode: 'reference-image',
          ratio: '4:3',
          resolution: '2K',
          quantity: 1,
          durationSeconds: null,
          references: [
            { materialId: firstMaterialId, role: 'reference' },
            { materialId: secondMaterialId, role: 'reference' }
          ]
        }
      }}
    />
  )
  await selectSession(page, 'Spring campaign')

  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByLabel('Add reference material').click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'rejected.png',
    mimeType: 'image/png',
    buffer: Buffer.from('png')
  })

  const error = page.getByTestId('gallery-submit-error')
  await expect(error).toContainText('material_too_large')
  await error.getByRole('button', { name: 'Not now' }).click()
  await expect(error).toHaveCount(0)

  await page.getByTestId('composer-prompt').fill('Ready after dismiss')
  await page.getByTestId('composer-submit').click()
  await expect(page.getByTestId(`task-${acceptedTaskId}`)).toBeVisible()
  await expect(error).toHaveCount(0)
})

test('a confirmed failure from one session never follows a new draft', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory uploadOutcome="request-rejected" />)
  await selectSession(page, 'Spring campaign')

  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByLabel('Add reference material').click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'rejected.png',
    mimeType: 'image/png',
    buffer: Buffer.from('png')
  })
  await expect(page.getByTestId('gallery-submit-error')).toContainText('material_too_large')

  await page.getByTestId('session-new').click()
  await expect(page.getByTestId('composer')).toBeVisible()
  await expect(page.getByTestId('gallery-submit-error')).toHaveCount(0)
})

test('a session deleted after returning from Settings reconciles the current list', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchNavigationStory deleteSessionDeferred />)
  await selectSession(page, 'Spring campaign')

  const row = page
    .getByTestId('session-list')
    .getByRole('listitem')
    .filter({ hasText: 'Spring campaign' })
  await row.hover()
  await row.getByTestId('session-menu-aaaaaaaa-0000-4000-8000-000000000001').click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.deletedSessionIds() ?? []))
    .toEqual(['aaaaaaaa-0000-4000-8000-000000000001'])

  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Back to creation' }).click()
  await expect(page.getByRole('button', { name: 'Spring campaign', exact: true })).toBeVisible()

  await page.evaluate(() => window.__creationDeckTest?.releaseSessionDeletes())
  await expect(page.getByRole('button', { name: 'Spring campaign', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Workspace')).toContainText(
    'Pick or create a session to start your work'
  )
})

test('an existing-session replacement finishes its original context while Settings is visible', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchNavigationStory uploadDeferred />)
  await selectSession(page, 'Spring campaign')
  await expect(page.getByTestId('composer')).toBeVisible()

  await replaceByDrop(page, firstMaterialId, 'replacement.png')
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.uploadCalls() ?? []))
    .toHaveLength(1)
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.evaluate(() => window.__creationDeckTest?.releaseUploads())
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__creationDeckTest?.draftRecord('aaaaaaaa-0000-4000-8000-000000000001')
            ?.references ?? []
      )
    )
    .toEqual([
      { materialId: uploadedMaterialId, role: 'reference' },
      { materialId: secondMaterialId, role: 'reference' }
    ])

  await page.getByRole('button', { name: 'Back to creation' }).click()
  await expect(page.getByTestId('composer')).toBeVisible()
  await expect(page.getByRole('button', { name: 'replacement.png', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'poster.png', exact: true })).toHaveCount(0)
  expect(
    await page.evaluate(() =>
      window.__creationDeckTest?.materialIds('aaaaaaaa-0000-4000-8000-000000000001')
    )
  ).toContain(firstMaterialId)
})

test('a slow replacement merges with reference edits made while upload is pending', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory uploadDeferred />)
  await selectSession(page, 'Spring campaign')

  await replaceByDrop(page, firstMaterialId, 'replacement.png')
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.uploadCalls() ?? []))
    .toHaveLength(1)

  await page.getByRole('button', { name: 'banner.png', exact: true }).focus()
  await page.getByRole('button', { name: 'Remove banner.png', exact: true }).click()

  await page.evaluate(() => window.__creationDeckTest?.releaseUploads())
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__creationDeckTest?.draftRecord('aaaaaaaa-0000-4000-8000-000000000001')
            ?.references ?? []
      )
    )
    .toEqual([{ materialId: uploadedMaterialId, role: 'reference' }])
  await expect(page.getByRole('button', { name: 'replacement.png', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'banner.png', exact: true })).toHaveCount(0)
})

test('a slow completion reconcile preserves edits and the visible draft while facts load', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory taskScript={{ submitDeferred: true }} />)
  await selectSession(page, 'Spring campaign')
  await page.getByTestId('composer-prompt').fill('Draft before task acceptance')
  await page.getByTestId('composer-submit').click()
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? []))
    .toHaveLength(1)

  await page.evaluate(() => window.__creationDeckTest?.deferNextMaterialList())
  await page.evaluate(() => window.__creationDeckTest?.releaseSubmissions())
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.materialListCalls() ?? 0))
    .toBe(2)

  await expect(page.getByTestId('composer-prompt')).toHaveText('Draft before task acceptance')
  await page.getByTestId('composer-prompt').fill('Edit made while facts are loading')
  await page.evaluate(() => window.__creationDeckTest?.releaseFirstMaterialList())

  await expect(page.getByTestId('composer-prompt')).toHaveText('Edit made while facts are loading')
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.__creationDeckTest?.draftRecord('aaaaaaaa-0000-4000-8000-000000000001') ?? null
      )
    )
    .toMatchObject({
      prompt: 'Edit made while facts are loading',
      mediaType: 'image',
      model: 'doubao-seedream-5.0-pro',
      ratio: '4:3',
      resolution: '2K',
      quantity: 2,
      references: [
        { materialId: firstMaterialId, role: 'reference' },
        { materialId: secondMaterialId, role: 'reference' }
      ]
    })
})

test('a stale first A read cannot overwrite a later A selection', async ({ mount, page }) => {
  await mount(
    <CreationWorkbenchStory deferFirstMaterialListFor="aaaaaaaa-0000-4000-8000-000000000001" />
  )

  await selectSession(page, 'Spring campaign')
  await selectSession(page, 'Untitled creation')
  await expect(page.getByTestId('composer')).toBeVisible()
  await selectSession(page, 'Spring campaign')
  await expect(page.locator('[data-testid="deck-strip"] [data-material-id]')).toHaveCount(2)

  await page.evaluate(() => window.__creationDeckTest?.releaseFirstMaterialList())
  await expect(page.locator('[data-testid="deck-strip"] [data-material-id]')).toHaveCount(2)
})

test('reload restores only an unconfirmed warning, never a resumable submission', async ({
  mount,
  page
}) => {
  const draft: LocalDraftRecord = {
    prompt: 'Editable draft after restart',
    promptDocument: {
      version: 1,
      nodes: [{ type: 'text', text: 'Editable draft after restart' }]
    },
    mediaType: 'image',
    manifestVersion: 5,
    model: 'doubao-seedream-5.0-pro',
    mode: 'text-to-image',
    ratio: '1:1',
    resolution: '2K',
    quantity: 1,
    durationSeconds: null,
    references: [],
    operationNotice: { submissionUnconfirmed: true, materialFileNames: [] }
  }
  await mount(
    <CreationWorkbenchStory
      drafts={{ 'aaaaaaaa-0000-4000-8000-000000000001': draft }}
      materials={{}}
    />
  )
  await selectSession(page, 'Spring campaign')

  await expect(page.getByTestId('creation-action-notice')).toContainText(
    'Its submission key is not retained across an app restart'
  )
  await expect(page.getByTestId('creation-resume-submission')).toHaveCount(0)
  expect(await page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? [])).toEqual([])
  await page.getByTestId('creation-stop-tracking').click()
  await expect(page.getByTestId('creation-action-notice')).toHaveCount(0)
})

// --- no-identity submission ownership (issue #193) -------------------------

const materializedSessionId = 'eeeeeeee-0000-4000-8000-000000000007'

test('a new-draft submission owns its pending entry and converts without stealing focus', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory createSessionDeferred />)
  await page.getByTestId('session-new').click()
  await page.getByTestId('composer-prompt').fill('Draft A prompt')
  await page.getByTestId('composer-submit').click()

  await expect(page.getByTestId('session-list')).toContainText('Draft A prompt')
  await expect(page.getByTestId('composer-submit')).toBeDisabled()

  await page.getByTestId('session-new').click()
  await expect(page.getByTestId('workspace-hero')).toBeVisible()
  await page.getByTestId('composer-prompt').fill('Draft B prompt')
  await expect(page.getByTestId('composer-submit')).toBeEnabled()

  await page.evaluate(() => window.__creationDeckTest?.releaseSessionCreations())
  await expect(page.getByTestId('session-list')).not.toContainText('Draft A prompt')
  await expect(page.getByTestId('composer-prompt')).toContainText('Draft B prompt')
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? []))
    .toHaveLength(1)
  const calls = await page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? [])
  expect(calls[0]?.sessionId).toBe(materializedSessionId)
  expect(calls[0]?.intent.prompt).toBe('Draft A prompt')
  const moved = await page.evaluate(
    (key: string) => window.__creationDeckTest?.draftRecord(key) ?? null,
    materializedSessionId
  )
  expect(moved?.prompt).toBe('Draft A prompt')
})

test('a first submission carries both drafts and waits only for its selected file', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory createSessionDeferred uploadDeferred />)
  await page.getByTestId('session-new').click()
  await selectMedia(page, 'Video generation')
  await page.getByTestId('composer-prompt').fill('video draft')
  await selectMedia(page, 'Image generation')
  await page.getByTestId('composer-prompt').fill('image task')
  let chooserPromise = page.waitForEvent('filechooser')
  await page.getByLabel('Add reference material').click()
  await (
    await chooserPromise
  ).setFiles({
    name: 'image-reference.png',
    mimeType: 'image/png',
    buffer: Buffer.from('image')
  })

  await page.getByTestId('composer-submit').click()
  await selectMedia(page, 'Video generation')
  await page.getByTestId('composer-prompt').fill('video edited while pending')
  chooserPromise = page.waitForEvent('filechooser')
  await page.getByLabel('Add reference material').click()
  await (
    await chooserPromise
  ).setFiles({
    name: 'video-frame.png',
    mimeType: 'image/png',
    buffer: Buffer.from('video')
  })
  await expect(page.getByTestId('composer-submit')).toBeDisabled()
  await page.getByTestId('session-new').click()
  await page.getByTestId('composer-prompt').fill('later creation')
  expect(await page.evaluate(() => window.__creationDeckTest?.uploadCalls() ?? [])).toEqual([])

  await page.evaluate(() => window.__creationDeckTest?.releaseSessionCreations())
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.uploadCalls() ?? []))
    .toHaveLength(2)
  await page.evaluate(() => window.__creationDeckTest?.releaseNextUpload())
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? []))
    .toHaveLength(1)
  const calls = await page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? [])
  expect(calls[0]?.intent).toMatchObject({
    prompt: 'image task',
    mediaType: 'image',
    model: 'doubao-seedream-5.0-pro'
  })
  expect(calls[0]?.intent.references).toHaveLength(1)
  await expect(page.getByTestId('composer-prompt')).toHaveText('later creation')

  await page.getByTestId(`session-${materializedSessionId}`).click()
  await expect(page.getByTestId('composer-prompt')).toHaveText('video edited while pending')
  await expect(page.getByRole('button', { name: /First frame.*video-frame\.png/ })).toBeVisible()
  await selectMedia(page, 'Image generation')
  await expect(page.getByTestId('composer-prompt')).toHaveText('image task')
  await expect(page.getByTestId('composer-submit')).toBeEnabled()
  await page.evaluate(() => window.__creationDeckTest?.releaseUploads())
  await selectMedia(page, 'Video generation')
  await expect(page.getByRole('button', { name: /First frame.*video-frame\.png/ })).toBeVisible()
  await expect(page.getByTestId('composer-submit')).toBeEnabled()
  await page.getByTestId('composer-submit').click()
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? []))
    .toHaveLength(2)
  const videoCall = (await page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? []))[1]
  expect(videoCall?.intent.prompt).toBe('video edited while pending')
  expect(videoCall?.intent.references).toHaveLength(1)
  expect(videoCall?.intent.references[0]?.materialId).not.toBe(
    calls[0]?.intent.references[0]?.materialId
  )
})

test('an unconfirmed first session keeps both drafts and its notice', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory createSessionOutcome="network-failure" />)
  await page.getByTestId('session-new').click()
  await page.getByTestId('composer-prompt').fill('image draft')
  await selectMedia(page, 'Video generation')
  await page.getByTestId('composer-prompt').fill('video draft')
  await page.getByTestId('composer-submit').click()

  await expect(page.getByTestId('creation-action-notice')).toContainText(
    'session creation outcome could not be confirmed'
  )
  await selectMedia(page, 'Image generation')
  await expect(page.getByTestId('composer-prompt')).toHaveText('image draft')
  await selectMedia(page, 'Video generation')
  await expect(page.getByTestId('composer-prompt')).toHaveText('video draft')
  await page.getByTestId('session-new').click()
  await page.getByTestId('composer-prompt').fill('later creation')
  await page.getByRole('button', { name: 'video draft' }).click()
  await expect(page.getByTestId('composer-prompt')).toHaveText('video draft')
  await expect(page.getByTestId('creation-action-notice')).toContainText(
    'session creation outcome could not be confirmed'
  )
})

test('a hidden draft upload failure does not block the selected task', async ({ mount, page }) => {
  await mount(<CreationWorkbenchStory uploadDeferred uploadOutcome="request-rejected" />)
  await page.getByTestId('session-new').click()
  await page.getByTestId('composer-prompt').fill('image draft')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByLabel('Add reference material').click()
  await (
    await chooserPromise
  ).setFiles({
    name: 'hidden-image.png',
    mimeType: 'image/png',
    buffer: Buffer.from('image')
  })
  await selectMedia(page, 'Video generation')
  await page.getByTestId('composer-prompt').fill('video task')
  await page.getByTestId('composer-submit').click()

  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? []))
    .toHaveLength(1)
  const calls = await page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? [])
  expect(calls[0]?.intent).toMatchObject({
    prompt: 'video task',
    mediaType: 'video',
    references: []
  })
  await expect(page.getByTestId('gallery-submit-error')).toHaveCount(0)
  await page.evaluate(() => window.__creationDeckTest?.releaseUploads())
  await selectMedia(page, 'Image generation')
  await expect(page.getByTestId('gallery-submit-error')).toContainText('material_too_large')
  await selectMedia(page, 'Video generation')
  await expect(page.getByTestId('gallery-submit-error')).toHaveCount(0)
})

test('a removed hidden binding cannot retarget its held file upload', async ({ mount, page }) => {
  await mount(
    <CreationWorkbenchStory createSessionDeferred uploadDeferred uploadOutcome="request-rejected" />
  )
  await page.getByTestId('session-new').click()
  await selectMedia(page, 'Video generation')
  await page.getByTestId('composer-prompt').fill('video draft')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByLabel('Add reference material').click()
  await (
    await chooserPromise
  ).setFiles({
    name: 'held-frame.png',
    mimeType: 'image/png',
    buffer: Buffer.from('video')
  })
  await selectMedia(page, 'Image generation')
  await page.getByTestId('composer-prompt').fill('image task')
  await page.getByTestId('composer-submit').click()
  await selectMedia(page, 'Video generation')
  await page.getByRole('button', { name: /First frame.*held-frame\.png/ }).focus()
  await page.getByRole('button', { name: 'Remove held-frame.png', exact: true }).click()
  await expect(page.getByRole('button', { name: /First frame.*held-frame\.png/ })).toHaveCount(0)
  await selectMedia(page, 'Image generation')

  await page.evaluate(() => window.__creationDeckTest?.releaseSessionCreations())
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.taskCalls() ?? []))
    .toHaveLength(1)
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.uploadCalls() ?? []))
    .toHaveLength(1)
  await page.evaluate(() => window.__creationDeckTest?.releaseUploads())
  await selectMedia(page, 'Video generation')
  await expect(page.getByTestId('gallery-submit-error')).toContainText('material_too_large')
  await selectMedia(page, 'Image generation')
  await expect(page.getByTestId('gallery-submit-error')).toHaveCount(0)
})

test('watching a pending draft follows its conversion into the real session', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory createSessionDeferred />)
  await page.getByTestId('session-new').click()
  await page.getByTestId('composer-prompt').fill('Draft A prompt')
  await page.getByTestId('composer-submit').click()
  await expect(page.getByTestId('creation-action-notice')).toContainText(
    'continuing in the background'
  )

  await page.evaluate(() => window.__creationDeckTest?.releaseSessionCreations())
  await expect(page.getByTestId('composer-prompt')).toContainText('Draft A prompt')
  await expect(page.getByTestId(`task-${acceptedTaskId}`)).toBeVisible()
  await expect(page.getByTestId('session-list')).not.toContainText('Draft A prompt')
})

test('an ambiguous session creation shows the unconfirmed notice and never resends', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory createSessionOutcome="network-failure" />)
  await page.getByTestId('session-new').click()
  await page.getByTestId('composer-prompt').fill('Draft A prompt')
  await page.getByTestId('composer-submit').click()

  await expect(page.getByTestId('creation-action-notice')).toContainText(
    'session creation outcome could not be confirmed'
  )
  await expect(page.getByTestId('session-list')).toContainText('Draft A prompt')
  await expect(page.getByTestId('composer-submit')).toBeDisabled()
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.createSessionCalls() ?? []))
    .toHaveLength(1)

  await page.getByTestId('creation-stop-tracking').click()
  await expect(page.getByTestId('creation-action-notice')).toHaveCount(0)
  await expect(page.getByTestId('session-list')).toContainText('Draft A prompt')
  await expect(page.getByTestId('composer-submit')).toBeEnabled()
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.createSessionCalls() ?? []))
    .toHaveLength(1)
})

test('a reloaded pending draft keeps its entry and notice but resumes nothing', async ({
  mount,
  page
}) => {
  const reloadPendingKey = 'pending:99999999-9999-4999-8999-999999999999'
  const pendingDraft: LocalDraftRecord = {
    prompt: 'Unconfirmed creation prompt',
    promptDocument: {
      version: 1,
      nodes: [{ type: 'text', text: 'Unconfirmed creation prompt' }]
    },
    mediaType: 'image',
    manifestVersion: 5,
    model: 'doubao-seedream-5.0-pro',
    mode: 'text-to-image',
    ratio: '1:1',
    resolution: '2K',
    quantity: 1,
    durationSeconds: null,
    references: [],
    operationNotice: {
      sessionUnconfirmed: true,
      submissionUnconfirmed: false,
      materialFileNames: []
    }
  }
  await mount(<CreationWorkbenchStory drafts={{ [reloadPendingKey]: pendingDraft }} />)

  await expect(page.getByTestId('session-list')).toContainText('Unconfirmed creation prompt')
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.createSessionCalls() ?? []))
    .toHaveLength(0)

  await page.getByRole('button', { name: 'Unconfirmed creation prompt' }).click()
  await expect(page.getByTestId('composer-prompt')).toContainText('Unconfirmed creation prompt')
  await expect(page.getByTestId('creation-action-notice')).toContainText(
    'previous session creation outcome was unconfirmed'
  )
  await page.getByTestId('composer-submit').click()
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.createSessionCalls() ?? []))
    .toHaveLength(1)
  await expect(page.getByTestId(`task-${acceptedTaskId}`)).toBeVisible()
})

test('a held file survives display switches and re-mounts its card on return', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory createSessionDeferred />)
  await page.getByTestId('session-new').click()
  await page.getByTestId('composer-prompt').fill('Deck keeps its files')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByLabel('Add reference material').click()
  const chooser = await chooserPromise
  await chooser.setFiles({
    name: 'held.png',
    mimeType: 'image/png',
    buffer: Buffer.from('png')
  })
  await expect(
    page.getByTestId('reference-deck').getByRole('button', { name: 'held.png', exact: true })
  ).toBeVisible()

  await page.getByTestId('composer-submit').click()
  // The runtime owns the file now; switching away drops display resources only.
  await page.getByTestId('session-new').click()
  await expect(page.getByTestId('workspace-hero')).toBeVisible()
  expect(await page.evaluate(() => window.__creationDeckTest?.uploadCalls() ?? [])).toEqual([])

  const entry = page.getByRole('button', { name: 'Deck keeps its files' })
  await entry.click()
  await expect(
    page.getByTestId('reference-deck').getByRole('button', { name: 'held.png', exact: true })
  ).toBeVisible()
  expect(await page.evaluate(() => window.__creationDeckTest?.uploadCalls() ?? [])).toEqual([])
})

// The frame painted while an entry's first window is in flight is what the
// creator sees on arrival: a wait, never an empty session.
test('a returning entry reads as loading, never as the empty-session hero', async ({
  mount,
  page
}) => {
  const task: ScriptedTask = {
    id: 'ffffffff-1111-4000-8000-00000000d001',
    sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
    status: 'succeeded',
    mediaType: 'image',
    slotCount: 1,
    snapshot: null,
    cancelRequested: false,
    terminalCause: null,
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt: '2026-09-01T09:00:00Z',
    terminalAt: '2026-09-01T09:00:00Z',
    slots: [{ index: 0, status: 'succeeded', failureReason: null, result: null }]
  }
  // An empty draft, so the held task read is the only fact that could land.
  await mount(<CreationWorkbenchNavigationStory drafts={{}} taskScript={{ tasks: [task] }} />)
  await selectSession(page, 'Spring campaign')
  await expect(page.getByTestId(`task-${task.id}`)).toBeVisible()

  await page.getByRole('button', { name: 'Open settings' }).click()
  const callsBefore = await page.evaluate(() => window.__creationDeckTest?.listTasksCalls() ?? 0)
  await page.evaluate(() => window.__creationDeckTest?.holdNextListResponse())
  await page.getByRole('button', { name: 'Back to creation' }).click()
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.listTasksCalls() ?? 0))
    .toBeGreaterThan(callsBefore)

  const loading = page.getByTestId('workspace-loading')
  await expect(loading).toBeVisible()
  expect(await loading.locator('[data-slot="skeleton"]').count()).toBeGreaterThan(0)
  await expect(page.getByTestId('workspace-hero')).toHaveCount(0)

  await page.evaluate(() => window.__creationDeckTest?.releaseHeldListResponses())
  await expect(page.getByTestId(`task-${task.id}`)).toBeVisible()
  await expect(page.getByTestId('workspace-loading')).toHaveCount(0)
})
