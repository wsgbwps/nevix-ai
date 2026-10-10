import { expect, test, type Route } from '@playwright/experimental-ct-react'
import {
  ServerReleaseSettingsStory,
  ServerReleaseConnectionSwitchStory
} from './fixtures/server-release-settings.story'

for (const language of ['en', 'zh-CN'] as const) {
  test(`Admin can inspect and manually check Server updates in ${language}`, async ({
    mount,
    page
  }) => {
    let check = 0
    await page.route('https://server.test/release/**', async (route) => {
      expect(route.request().headers().authorization).toBe('Bearer admin-session')
      const manual = route.request().method() === 'POST'
      if (manual) check++
      await route.fulfill({
        json: {
          version: '2.0.0',
          min_desktop_version: '1.0.0',
          checked_at: manual ? '2026-10-09T00:00:00Z' : null,
          outcome: manual ? (check === 1 ? 'available' : 'network-failure') : 'not-checked',
          candidate:
            manual && check === 1
              ? {
                  version: '2.1.0',
                  min_server_version: '2.0.0',
                  min_desktop_version: '1.5.0',
                  compatible: true
                }
              : null
        }
      })
    })
    const component = await mount(<ServerReleaseSettingsStory language={language} />)
    await expect(component.getByText('2.0.0', { exact: true })).toBeVisible()
    await component
      .getByRole('button', { name: language === 'en' ? 'Check now' : '立即检查' })
      .click()
    await expect(component.getByText('2.1.0', { exact: true })).toBeVisible()
    await expect(component.getByText('1.5.0', { exact: true })).toBeVisible()
    await expect(component.getByRole('status')).toContainText(
      language === 'en' ? 'A Server update is available' : '有可用的服务器更新'
    )
    await component
      .getByRole('button', { name: language === 'en' ? 'Check now' : '立即检查' })
      .click()
    await expect(component.getByRole('status')).toContainText(
      language === 'en' ? 'Could not reach the official update source' : '无法连接官方更新源'
    )
    await expect(component.getByText('2.1.0', { exact: true })).toHaveCount(0)
  })
}

test('switching Server discards the previous connection check result', async ({ mount, page }) => {
  let pending: Route | undefined
  await page.route('https://server.test/release/**', async (route) => {
    if (route.request().method() === 'POST') {
      pending = route
      return
    }
    await route.fulfill({
      json: {
        version: '2.0.0',
        min_desktop_version: '1.0.0',
        checked_at: null,
        outcome: 'not-checked',
        candidate: null
      }
    })
  })
  await page.route('https://other.test/release/status', (route) =>
    route.fulfill({
      json: {
        version: '3.0.0',
        min_desktop_version: '2.0.0',
        checked_at: null,
        outcome: 'not-checked',
        candidate: null
      }
    })
  )
  const component = await mount(<ServerReleaseConnectionSwitchStory />)
  await expect(component.getByText('2.0.0', { exact: true })).toBeVisible()
  await component.getByRole('button', { name: 'Check now' }).click()
  await expect.poll(() => !!pending).toBe(true)
  await component.getByRole('button', { name: 'Switch server' }).click()
  await expect(component.getByText('3.0.0', { exact: true })).toBeVisible()
  await pending!.fulfill({
    json: {
      version: '2.0.0',
      min_desktop_version: '1.0.0',
      checked_at: '2026-10-09T00:00:00Z',
      outcome: 'available',
      candidate: {
        version: '2.1.0',
        min_server_version: '2.0.0',
        min_desktop_version: '1.5.0',
        compatible: true
      }
    }
  })
  await expect(component.getByText('3.0.0', { exact: true })).toBeVisible()
  await expect(component.getByText('2.1.0', { exact: true })).toHaveCount(0)
})

test('manual check refuses a redirected Server response', async ({ mount, page }) => {
  const value = {
    version: '2.0.0',
    min_desktop_version: '1.0.0',
    checked_at: null,
    outcome: 'not-checked',
    candidate: null
  }
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'Authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  }
  await page.route('https://server.test/**', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    if (new URL(route.request().url()).pathname === '/release/check')
      return route.fulfill({
        status: 302,
        headers: { ...headers, location: 'https://server.test/unexpected' }
      })
    return route.fulfill({ json: value, headers })
  })
  const component = await mount(<ServerReleaseSettingsStory />)
  await expect(component.getByText('2.0.0', { exact: true })).toBeVisible()
  await component.getByRole('button', { name: 'Check now' }).click()
  await expect(component.getByRole('status')).toContainText('Could not read update status')
})
