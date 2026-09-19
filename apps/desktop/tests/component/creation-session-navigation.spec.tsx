import { expect, test } from '@playwright/experimental-ct-react'
import { CreationWorkbenchRealShellStory } from './fixtures/creation-workbench-real-shell.story'
import type { CreationSessionView } from '../src/renderer/src/features/creation/api/go-creation-http'

const springSessionId = 'aaaaaaaa-0000-4000-8000-000000000001'

test('the global session navigation keeps its compact controls and sidebar state', async ({
  mount,
  page
}) => {
  await page.evaluate(() => {
    document.cookie = 'sidebar_state=; path=/; max-age=0'
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
    document.cookie = 'sidebar_state=; path=/; max-age=0'
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
