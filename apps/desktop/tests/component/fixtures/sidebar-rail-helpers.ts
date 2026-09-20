import { expect, type Page } from '@playwright/experimental-ct-react'

/** The rail width the sidebar collapses to (`--sidebar-width-icon`). */
export const collapsedRailWidth = 48

/**
 * Collapses the sidebar and waits for its width to settle: the rail, group label and
 * brand all animate for 200ms, so a measurement taken earlier is a mid-transition
 * snapshot. Polling keeps a geometry assertion honest — the create button still clears
 * the first session row while the rail is wide.
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
 * Tabs forward until `target` owns focus. The collapsed rail keeps several shell
 * navigation controls ahead of the session list in the tab order, so a fixed press
 * count would pin the count instead of the reachability the assertion is about.
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
