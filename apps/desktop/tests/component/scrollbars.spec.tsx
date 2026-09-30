import { expect, test } from '@playwright/experimental-ct-react'
import type { Locator } from '@playwright/test'
import { ScrollbarsStory } from './fixtures/scrollbars.story'

// The headless default hides native scrollbars, including their drag hit targets.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

async function thumbOpacity(area: Locator): Promise<number | null> {
  return area.evaluate((element) => {
    const background = getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundImage
    const alpha = background.match(/\/ ([\d.]+)\)/)
    return alpha === null ? null : Number(alpha[1])
  })
}

test('scrollbars appear during scrolling and fade after one second without moving content', async ({
  mount,
  page
}) => {
  await mount(<ScrollbarsStory />)
  const area = page.getByLabel('Outer scroll area')
  await page.mouse.move(10, 10)
  const width = await area.evaluate((element) => element.clientWidth)
  expect(await thumbOpacity(area)).toBe(0)

  await area.hover({ position: { x: 250, y: 100 } })
  await page.mouse.wheel(0, 100)
  await expect.poll(() => thumbOpacity(area)).toBe(0.18)
  await expect.poll(() => thumbOpacity(area), { timeout: 2000 }).toBe(0)
  expect(await area.evaluate((element) => element.clientWidth)).toBe(width)
})

test('horizontal scrolling and keyboard scrolling only reveal the active nested region', async ({
  mount,
  page
}) => {
  await mount(<ScrollbarsStory />)
  const outer = page.getByLabel('Outer scroll area')
  const inner = page.getByLabel('Inner scroll area')
  await inner.focus()
  await page.keyboard.press('PageDown')
  await expect.poll(() => inner.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect.poll(() => thumbOpacity(inner)).toBe(0.18)
  expect(await thumbOpacity(outer)).toBe(0)

  await outer.hover({ position: { x: 250, y: 100 } })
  await page.mouse.wheel(100, 0)
  await expect.poll(() => outer.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  await expect.poll(() => thumbOpacity(outer)).toBe(0.18)
  await expect.poll(() => thumbOpacity(inner), { timeout: 2000 }).toBe(0)
  await expect.poll(() => thumbOpacity(outer), { timeout: 2000 }).toBe(0)
})

test('portalled Select viewports expose the same native scrollbar despite Radix hiding rules', async ({
  mount,
  page
}) => {
  await mount(<ScrollbarsStory />)
  await page.getByRole('combobox', { name: 'Scrollable select' }).click()
  const viewport = page.locator('[data-radix-select-viewport]')
  const gutter = await viewport.evaluate((element) => ({
    width: (element as HTMLElement).offsetWidth - element.clientWidth,
    scrollbarWidth: getComputedStyle(element).scrollbarWidth
  }))
  expect(gutter).toEqual({ width: 6, scrollbarWidth: 'auto' })
  await viewport.hover({ position: { x: 30, y: 30 } })
  await page.mouse.wheel(0, 100)
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect.poll(() => thumbOpacity(viewport)).toBe(0.18)
  await page.mouse.move(10, 10)
  await expect.poll(() => thumbOpacity(viewport), { timeout: 2000 }).toBe(0)
})

test('the hidden scrollbar reappears at the edge and remains visible while dragging', async ({
  mount,
  page
}) => {
  await mount(<ScrollbarsStory />)
  const area = page.getByLabel('Outer scroll area')
  const box = (await area.boundingBox())!
  const width = await area.evaluate((element) => element.clientWidth)
  await page.mouse.move(box.x + box.width - 9, box.y + 20)
  await expect.poll(() => thumbOpacity(area)).toBe(0.18)
  expect(
    await area.evaluate(
      (element) => getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundSize
    )
  ).toBe('6px 100%')

  await page.mouse.move(box.x + box.width - 3, box.y + 20)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 3, box.y + 130, { steps: 5 })
  await expect.poll(() => area.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await page.waitForTimeout(1300)
  await expect.poll(() => thumbOpacity(area)).toBeGreaterThan(0)
  await page.mouse.up()
  await page.mouse.move(10, 10)
  await expect.poll(() => thumbOpacity(area), { timeout: 2000 }).toBe(0)
  expect(await area.evaluate((element) => element.clientWidth)).toBe(width)
})

test('document scrollbar edges remain discoverable after the page has scrolled', async ({
  mount,
  page
}) => {
  await mount(<ScrollbarsStory documentScroll />)
  const root = page.locator('html')
  await page.mouse.move(800, 400)
  await page.mouse.wheel(0, 200)
  await expect.poll(() => root.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect.poll(() => thumbOpacity(root), { timeout: 2000 }).toBe(0)
  const viewport = page.viewportSize()!
  await page.mouse.move(500, viewport.height - 9)
  await expect.poll(() => thumbOpacity(root)).toBe(0.18)
})

test('scrollbar colors follow the theme and reduced motion disables the fade', async ({
  mount,
  page
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await mount(<ScrollbarsStory />)
  const area = page.getByLabel('Outer scroll area')
  await area.hover({ position: { x: 311, y: 100 } })
  await expect.poll(() => thumbOpacity(area)).toBe(0.18)
  const light = await area.evaluate(
    (element) => getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundImage
  )
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  const dark = await area.evaluate(
    (element) => getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundImage
  )
  expect(dark).not.toBe(light)
  await expect(area).toHaveCSS('transition-duration', '0s')
})
