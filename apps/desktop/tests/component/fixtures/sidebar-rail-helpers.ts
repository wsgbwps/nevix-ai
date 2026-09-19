import { expect, type Page } from '@playwright/experimental-ct-react'

/** The rail width the sidebar collapses to (`--sidebar-width-icon`). */
export const collapsedRailWidth = 48

/**
 * Collapses the sidebar and waits for the layout to settle. The collapsed
 * rail animates its width, the group label animates its margin, and the brand
 * toggles its opacity — all over 200ms — so anything measured before the rail
 * reaches its final width is a mid-transition snapshot. Polling for that width
 * is what keeps a geometry assertion from passing on a broken rail: the
 * create button still clears the first session row while the rail is wide, and
 * only overlaps once the transition lands.
 */
export async function collapseSidebarRail(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click()
  await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute('data-state', 'collapsed')
  await expect
    .poll(async () => {
      const box = await page.locator('[data-slot="sidebar-container"]').boundingBox()
      return box === null ? null : Math.round(box.width)
    })
    .toBe(collapsedRailWidth)
}

/**
 * Tabs forward until `target` owns focus. The collapsed rail keeps several
 * controls in the tab order ahead of the session list (the shell's own
 * navigation entries), so a fixed number of presses would pin the count
 * instead of the reachability the assertion is about.
 */
export async function tabUntilFocused(
  page: Page,
  target: ReturnType<Page['getByTestId']>
): Promise<void> {
  for (let presses = 0; presses < 12; presses += 1) {
    await page.keyboard.press('Tab')
    if (await target.evaluate((element) => element === document.activeElement)) return
  }
  throw new Error('Tab did not reach the target control')
}
