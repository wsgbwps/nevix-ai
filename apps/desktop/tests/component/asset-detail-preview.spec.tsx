import { expect, test } from '@playwright/experimental-ct-react'
import { AssetLibraryStory } from './fixtures/asset-library.story'

test('asset detail fills the content viewport and keeps the sidebar usable', async ({
  mount,
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await mount(<AssetLibraryStory />)
  const opener = page.getByRole('button', { name: 'Open asset asset-one' })
  await opener.click()
  const preview = page.getByRole('dialog')
  await expect(preview).toBeVisible()
  expect((await preview.getByRole('complementary').boundingBox())?.width).toBe(346)
  expect(await preview.boundingBox()).toEqual(
    await page.locator('[data-slot="sidebar-inset"]').boundingBox()
  )
  await page.screenshot({ path: '../../.scratch/asset-preview-1280.png' })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.screenshot({ path: '../../.scratch/asset-preview-1280-dark.png' })
  await page.getByRole('button', { name: 'Toggle Sidebar' }).click()
  await expect.poll(async () => (await preview.boundingBox())?.x).toBeLessThan(100)
  expect(await preview.boundingBox()).toEqual(
    await page.locator('[data-slot="sidebar-inset"]').boundingBox()
  )
  await page.getByRole('button', { name: 'Toggle Sidebar' }).click()
  await expect.poll(async () => (await preview.boundingBox())?.x).toBeGreaterThan(200)
  await page.setViewportSize({ width: 960, height: 600 })
  expect((await preview.getByRole('complementary').boundingBox())?.width).toBe(310)
  expect(await preview.boundingBox()).toEqual(
    await page.locator('[data-slot="sidebar-inset"]').boundingBox()
  )
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 960)
  await page.screenshot({ path: '../../.scratch/asset-preview-960-dark.png' })
  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)
  await expect(opener).toBeFocused()
})
