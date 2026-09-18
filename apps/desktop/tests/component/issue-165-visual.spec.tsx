import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/experimental-ct-react'
import { InspirationStory } from './fixtures/inspiration.story'

for (const viewport of [
  { width: 960, height: 600 },
  { width: 1280, height: 800 }
] as const) {
  test(`issue 165 admin safety detail at ${viewport.width}x${viewport.height}`, async ({
    mount,
    page
  }, testInfo) => {
    await page.setViewportSize(viewport)
    await mount(<InspirationStory state="admin" />)
    await page.getByRole('button', { name: 'Open inspiration admin-asset' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('region', { name: 'Asset restriction' })).toContainText('Active')
    await expect(dialog.getByRole('region', { name: 'Publication restriction' })).toContainText(
      'Active'
    )
    const media = dialog.locator('img').first()
    await expect(media).toBeVisible()
    await expect
      .poll(() => media.evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0)
    await expect(dialog).toHaveCSS('overflow', 'hidden')

    const directory = resolve(
      testInfo.config.rootDir,
      '../../../../.scratch/issue-165-admin-safety-hardening/ui/inspiration'
    )
    await mkdir(directory, { recursive: true })
    await page.screenshot({
      animations: 'disabled',
      path: resolve(directory, `admin-safety-${viewport.width}x${viewport.height}.png`)
    })
  })
}
