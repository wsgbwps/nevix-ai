import { expect, test, type Page } from '@playwright/experimental-ct-react'
import { CreationWorkbenchRealShellStory } from './fixtures/creation-workbench-real-shell.story'
import { collapseSidebarRail } from './fixtures/sidebar-rail-helpers'
import type { CreationSessionView } from '../src/renderer/src/features/creation/api/go-creation-http'

const sessions: CreationSessionView[] = ['alpha', 'beta'].map((id) => ({
  id,
  name: `Session ${id}`,
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z'
}))

async function mountShell(
  mount: (component: React.JSX.Element) => Promise<unknown>,
  page: Page
): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('sidebar_state')
  })
  await mount(<CreationWorkbenchRealShellStory sessions={sessions} />)
}

/** Centre of an element's content box, or null while it is unmounted. */
async function centre(
  locator: ReturnType<Page['getByTestId']>
): Promise<{ readonly x: number; readonly y: number } | null> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    // clientLeft/clientTop are the border widths, which sit outside the
    // content box a centred child measures from.
    return {
      x: rect.x + element.clientLeft + element.clientWidth / 2,
      y: rect.y + element.clientTop + element.clientHeight / 2
    }
  })
}

/** Distance between two elements' centres, or null while either is unmounted. */
async function centreDelta(
  left: ReturnType<Page['getByTestId']>,
  right: ReturnType<Page['getByTestId']>,
  axis: 'x' | 'y'
): Promise<number | null> {
  const [leftCentre, rightCentre] = await Promise.all([centre(left), centre(right)])
  if (leftCentre === null || rightCentre === null) return null
  return leftCentre[axis] - rightCentre[axis]
}

test('the collapsed rail centres the brand in its header slot', async ({ mount, page }) => {
  await mountShell(mount, page)
  await collapseSidebarRail(page)

  // Measured against the rail's content box — the box its border sits outside
  // of, and the one the navigation icons below centre within.
  const rail = page.locator('[data-slot="sidebar-container"]')
  const brand = page.getByTestId('sidebar-brand')
  await expect(brand).toBeVisible()

  await expect.poll(() => centreDelta(brand, rail, 'x')).toBe(0)
})

test('the collapsed rail hides its toggle on the brand and reveals it on hover', async ({
  mount,
  page
}) => {
  await mountShell(mount, page)
  await collapseSidebarRail(page)

  const sidebar = page.locator('[data-slot="sidebar"]')
  const brand = page.getByTestId('sidebar-brand')
  const toggle = page.getByRole('button', { name: 'Toggle sidebar', exact: true })

  // The toggle occupies the brand mark's slot at rest: hidden, but the target
  // a pointer arriving on the logo actually lands on.
  await expect(toggle).toHaveCSS('opacity', '0')
  await expect.poll(() => centreDelta(toggle, brand, 'x')).toBe(0)
  await expect.poll(() => centreDelta(toggle, brand, 'y')).toBe(0)
  const toggleBox = await toggle.boundingBox()
  const brandBox = await brand.boundingBox()
  expect(toggleBox).not.toBeNull()
  expect(brandBox).not.toBeNull()
  if (toggleBox === null || brandBox === null) return
  expect(toggleBox.x).toBeLessThanOrEqual(brandBox.x)
  expect(toggleBox.y).toBeLessThanOrEqual(brandBox.y)
  expect(toggleBox.x + toggleBox.width).toBeGreaterThanOrEqual(brandBox.x + brandBox.width)
  expect(toggleBox.y + toggleBox.height).toBeGreaterThanOrEqual(brandBox.y + brandBox.height)

  // The reveal fades rather than cutting.
  const reveal = await toggle.evaluate((element) => {
    const style = getComputedStyle(element)
    return { property: style.transitionProperty, duration: style.transitionDuration }
  })
  expect(reveal.property).toMatch(/opacity|all/)
  expect(Number.parseFloat(reveal.duration)).toBeGreaterThan(0)

  // Hovering the mark means pointing at the toggle that covers it — the row's
  // own hover state is what drives the reveal.
  await toggle.hover()
  await expect(toggle).toHaveCSS('opacity', '1')
  await expect(brand).toHaveCSS('opacity', '0')

  // Revealed on hover, the toggle is usable and expands the rail again.
  await toggle.click()
  await expect(sidebar).toHaveAttribute('data-state', 'expanded')
  await expect(brand).toHaveCSS('opacity', '1')
})
