import { expect, test } from '@playwright/experimental-ct-react'
import { CreationWorkbenchRealShellStory } from './fixtures/creation-workbench-real-shell.story'
import { collapseSidebarRail, tabUntilFocused } from './fixtures/sidebar-rail-helpers'
import type { CreationSessionView } from '../src/renderer/src/features/creation/api/go-creation-http'

const springSessionId = 'aaaaaaaa-0000-4000-8000-000000000001'

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

const railSessions: CreationSessionView[] = Array.from({ length: 40 }, (_, index) => ({
  id: `session-${index}`,
  name: `Session ${index}`,
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z'
}))

test('the session group collapses without hiding the new draft action', async ({ mount, page }) => {
  await page.evaluate(() => {
    localStorage.removeItem('sidebar_state')
  })
  await mount(<CreationWorkbenchRealShellStory />)

  const toggle = page.getByRole('button', { name: 'Creation sessions', exact: true })
  const spring = page.getByTestId(`session-${springSessionId}`)
  const newDraft = page.getByTestId('session-new')

  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await toggle.click()
  await expect(spring).toBeHidden()
  await expect(newDraft).toBeVisible()
})

test('an empty session list still offers the new draft entry', async ({ mount, page }) => {
  await page.evaluate(() => {
    localStorage.removeItem('sidebar_state')
  })
  await mount(<CreationWorkbenchRealShellStory sessions={[]} />)

  await expect(page.getByTestId('session-list')).toHaveText(
    'No creation sessions yet; start from a blank draft'
  )
  await expect(page.getByTestId('session-new')).toBeVisible()
})

test('the icon rail keeps the sessions after the group was collapsed', async ({ mount, page }) => {
  await page.evaluate(() => {
    localStorage.removeItem('sidebar_state')
  })
  await mount(<CreationWorkbenchRealShellStory />)

  await page.getByRole('button', { name: 'Creation sessions', exact: true }).click()
  await expect(page.getByTestId(`session-${springSessionId}`)).toBeHidden()

  await collapseSidebarRail(page)
  await expect(page.getByTestId('session-new')).toBeVisible()
  await expect(page.getByTestId(`session-${springSessionId}`)).toBeVisible()
  await expect(page.getByTestId(`session-identity-${springSessionId}`)).toBeVisible()
})

test('collapsed session controls stay aligned with the unified thin scrollbar', async ({
  mount,
  page
}) => {
  await page.evaluate(() => {
    localStorage.removeItem('sidebar_state')
  })
  await mount(<CreationWorkbenchRealShellStory sessions={railSessions} />)

  const newDraft = page.getByTestId('session-new')
  await collapseSidebarRail(page)
  await tabUntilFocused(page, newDraft)
  await expect(newDraft).toBeFocused()
  await expect
    .poll(async () => {
      const [newDraftIconBox, sessionIdentityBox] = await Promise.all([
        newDraft.locator('svg').boundingBox(),
        page.getByTestId('session-identity-session-0').boundingBox()
      ])
      if (newDraftIconBox === null || sessionIdentityBox === null) return null
      return (
        newDraftIconBox.x +
        newDraftIconBox.width / 2 -
        (sessionIdentityBox.x + sessionIdentityBox.width / 2)
      )
    })
    .toBe(0)
  await expect
    .poll(async () => {
      const [newDraftBox, firstSessionBox] = await Promise.all([
        newDraft.boundingBox(),
        page.getByTestId('session-session-0').boundingBox()
      ])
      if (newDraftBox === null || firstSessionBox === null) return false
      return newDraftBox.y + newDraftBox.height <= firstSessionBox.y
    })
    .toBe(true)

  const listGeometry = await page.getByTestId('session-list').evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollbarWidth: getComputedStyle(element).scrollbarWidth,
    nativeScrollbarWidth: getComputedStyle(element, '::-webkit-scrollbar').width
  }))
  expect(listGeometry.scrollHeight).toBeGreaterThan(listGeometry.clientHeight)
  expect(listGeometry.scrollWidth).toBe(listGeometry.clientWidth)
  expect.soft(listGeometry.scrollbarWidth).toBe('auto')
  expect(listGeometry.nativeScrollbarWidth).toBe('6px')
})

test('the collapsed session scrollbar stays above the sidebar rail for hover and native drag', async ({
  mount,
  page
}) => {
  await page.evaluate(() => localStorage.removeItem('sidebar_state'))
  await mount(<CreationWorkbenchRealShellStory sessions={railSessions} />)
  await collapseSidebarRail(page)
  const list = page.getByTestId('session-list')
  const box = (await list.boundingBox())!
  await page.mouse.move(box.x + box.width - 3, box.y + 20)
  await expect
    .poll(() =>
      list.evaluate((element) =>
        Number(getComputedStyle(element).getPropertyValue('--scrollbar-opacity'))
      )
    )
    .toBe(1)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 3, box.y + 120, { steps: 5 })
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await page.mouse.up()
  await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute('data-state', 'collapsed')
})

test('the global session navigation keeps its compact controls and sidebar state', async ({
  mount,
  page
}) => {
  await page.evaluate(() => {
    localStorage.removeItem('sidebar_state')
  })
  const component = await mount(<CreationWorkbenchRealShellStory createSessionDeferred />)
  const sidebar = page.locator('[data-slot="sidebar"]')
  const spring = page.getByTestId(`session-${springSessionId}`)

  await spring.click()
  await expect(spring).toHaveAttribute('data-active', 'true')

  const newDraft = page.getByTestId('session-new')
  await newDraft.click()
  await expect(page.getByTestId('composer')).toBeVisible()
  await expect(newDraft).toHaveAttribute('data-active', 'true')

  await page.getByTestId('composer-prompt').fill('Pending sidebar draft')
  await page.getByTestId('composer-submit').click()
  const pending = page.locator('[data-testid^="session-pending-"]')
  await expect(pending).toBeVisible()
  await expect(pending).toHaveAttribute('data-active', 'true')
  await expect(pending.locator('[data-pending-status="running"]')).toHaveCount(2)

  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click()
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
  await expect(page.getByTestId(`session-menu-${springSessionId}`)).toBeHidden()
  await expect(pending.locator('[data-testid^="pending-session-status-"]')).toBeVisible()

  await spring.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Spring campaign')
  await expect(pending).toHaveAttribute(
    'aria-label',
    'Pending sidebar draft · Submission in progress'
  )

  await page.evaluate(() => window.__creationDeckTest?.releaseSessionCreations())
  await component.unmount()
  await mount(<CreationWorkbenchRealShellStory />)
  await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute('data-state', 'collapsed')
})

test('a session identity keeps its grapheme and color when list order changes', async ({
  mount,
  page
}) => {
  await page.evaluate(() => {
    localStorage.removeItem('sidebar_state')
  })
  const named: CreationSessionView = {
    id: 'session-with-stable-identity',
    name: '👩🏽‍💻 launch',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z'
  }
  const other: CreationSessionView = {
    id: 'another-session',
    name: 'Other session',
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z'
  }

  const component = await mount(
    <CreationWorkbenchRealShellStory key="original-order" sessions={[named, other]} />
  )
  const identity = page.getByTestId(`session-identity-${named.id}`)
  await expect(identity).toHaveText('👩🏽‍💻')
  const color = await identity.getAttribute('class')

  await component.update(
    <CreationWorkbenchRealShellStory key="reordered" sessions={[other, named]} />
  )
  await expect(identity).toHaveText('👩🏽‍💻')
  await expect(identity).toHaveAttribute('class', color ?? '')
})
