import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/experimental-ct-react'
import { AssetLibraryStory } from './fixtures/asset-library.story'
import { InspirationStory } from './fixtures/inspiration.story'

const viewports = [
  { width: 960, height: 600 },
  { width: 1280, height: 800 }
] as const

for (const viewport of viewports) {
  test(`issue 164 member Inspiration visual at ${viewport.width}x${viewport.height}`, async ({
    mount,
    page
  }, testInfo) => {
    await page.setViewportSize(viewport)
    await mount(<InspirationStory state="dense" />)
    await expect(page.getByTestId('inspiration-card')).toHaveCount(24)
    const directory = resolve(
      testInfo.config.rootDir,
      '../../../../.scratch/issue-164-team-publication/ui/issue-164/production-inspiration'
    )
    await mkdir(directory, { recursive: true })
    await page.screenshot({
      animations: 'disabled',
      path: resolve(directory, `member-density-wall-${viewport.width}x${viewport.height}.png`)
    })
  })

  test(`issue 164 admin Inspiration visual at ${viewport.width}x${viewport.height}`, async ({
    mount,
    page
  }, testInfo) => {
    await page.setViewportSize(viewport)
    await mount(<InspirationStory state="admin" />)
    await expect(page.getByText('Published')).toBeVisible()
    await expect(page.getByText('Restricted')).toBeVisible()
    const directory = resolve(
      testInfo.config.rootDir,
      '../../../../.scratch/issue-164-team-publication/ui/issue-164/production-inspiration'
    )
    await mkdir(directory, { recursive: true })
    await page.screenshot({
      animations: 'disabled',
      path: resolve(directory, `admin-wall-${viewport.width}x${viewport.height}.png`)
    })
  })

  test(`issue 164 Inspiration detail visual at ${viewport.width}x${viewport.height}`, async ({
    mount,
    page
  }, testInfo) => {
    await page.setViewportSize(viewport)
    await mount(<InspirationStory />)
    await page.getByRole('button', { name: 'Open inspiration publication-1' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('A precise editorial launch scene')
    await expect(dialog.getByRole('button', { name: 'Create similar' })).toBeEnabled()
    const directory = resolve(
      testInfo.config.rootDir,
      '../../../../.scratch/issue-164-team-publication/ui/issue-164/production-inspiration'
    )
    await mkdir(directory, { recursive: true })
    await page.screenshot({
      animations: 'disabled',
      path: resolve(directory, `detail-create-similar-${viewport.width}x${viewport.height}.png`)
    })
  })

  test(`issue 164 Asset publication visual at ${viewport.width}x${viewport.height}`, async ({
    mount,
    page
  }, testInfo) => {
    await page.setViewportSize(viewport)
    await mount(<AssetLibraryStory />)
    await page.getByRole('button', { name: 'Open asset asset-one' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('A quiet launch scene')
    await expect(dialog.getByRole('button', { name: 'Publish to Inspiration' })).toBeEnabled()
    const directory = resolve(
      testInfo.config.rootDir,
      '../../../../.scratch/issue-164-team-publication/ui/issue-164/production-asset'
    )
    await mkdir(directory, { recursive: true })
    await page.screenshot({
      animations: 'disabled',
      path: resolve(directory, `publish-${viewport.width}x${viewport.height}.png`)
    })
    page.once('dialog', (confirmation) => void confirmation.accept())
    await page.getByRole('button', { name: 'Publish to Inspiration' }).click()
    await expect(page.getByRole('button', { name: 'Withdraw publication' })).toBeVisible()
    await page.screenshot({
      animations: 'disabled',
      path: resolve(directory, `withdraw-${viewport.width}x${viewport.height}.png`)
    })
  })
}
