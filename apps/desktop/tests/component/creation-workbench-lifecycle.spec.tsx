import { expect, test, type Page } from '@playwright/experimental-ct-react'
import {
  CreationWorkbenchNavigationStory,
  CreationWorkbenchStory
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
  await selectSession(page, 'Spring campaign')
  await expect(page.getByTestId(`task-${acceptedTaskId}`)).toBeVisible()
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
  await selectSession(page, 'Spring campaign')
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
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.deleteMaterialCalls() ?? []))
    .toEqual([firstMaterialId])

  await page.getByRole('button', { name: 'Back to creation' }).click()
  await selectSession(page, 'Spring campaign')
  await expect(page.getByRole('button', { name: 'replacement.png', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'poster.png', exact: true })).toHaveCount(0)
})

test('a slow replacement merges with reference edits made while DELETE is pending', async ({
  mount,
  page
}) => {
  await mount(<CreationWorkbenchStory deleteMaterialDeferred />)
  await selectSession(page, 'Spring campaign')

  await replaceByDrop(page, firstMaterialId, 'replacement.png')
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.deleteMaterialCalls() ?? []))
    .toEqual([firstMaterialId])

  await page.getByRole('button', { name: 'banner.png', exact: true }).focus()
  await page.getByRole('button', { name: 'Remove banner.png', exact: true }).click()
  await expect
    .poll(async () => page.evaluate(() => window.__creationDeckTest?.deleteMaterialCalls() ?? []))
    .toEqual([firstMaterialId, secondMaterialId])

  await page.evaluate(() => window.__creationDeckTest?.releaseMaterialDeletes())
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
