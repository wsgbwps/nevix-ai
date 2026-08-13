import { expect, test } from '@playwright/experimental-ct-react'
import type { Page } from '@playwright/test'
import {
  FailedStartupPrerequisiteStory,
  StaleStartupResultStory,
  StartupFailureStory,
  StartupRecoveryStory
} from './fixtures/organization-startup.story'

async function installSuccessfulStartupBoundaries(page: Page): Promise<void> {
  await page.route('https://component-test.supabase.co/rest/v1/**', async (route) => {
    const corsHeaders = {
      'access-control-allow-headers': 'authorization, apikey, content-profile, x-client-info',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-origin': '*'
    }
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { ...corsHeaders, 'content-range': '0-0/0' },
      body: '[]'
    })
  })
  await page.evaluate(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        invoke: async (channel: string) => {
          if (channel === 'organization:get-remembered-active-organization') {
            return { organizationId: null }
          }
          throw new Error(`Unexpected component-test IPC Channel: ${channel}`)
        }
      }
    })
  })
}

async function installSessionAwareStartupBoundaries(page: Page): Promise<void> {
  await page.route('https://component-test.supabase.co/rest/v1/**', async (route) => {
    const corsHeaders = {
      'access-control-allow-headers': 'authorization, apikey, content-profile, x-client-info',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-origin': '*'
    }
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders })
      return
    }
    const authorization = route.request().headers().authorization ?? ''
    const organizationPrefix = authorization.includes('old-session-token') ? 'old' : 'new'
    const table = new URL(route.request().url()).pathname.split('/').at(-1)
    const body =
      table === 'memberships'
        ? JSON.stringify([
            {
              role: 'owner',
              organizations: {
                id: `${organizationPrefix}-organization`,
                name: `${organizationPrefix} Organization`
              }
            }
          ])
        : '[]'
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { ...corsHeaders, 'content-range': '0-0/1' },
      body
    })
  })
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __startupFetchesSettled: number
      __rememberedOrganizationReads: number
      __rememberedOrganizationWrites: string[]
    }
    testWindow.__startupFetchesSettled = 0
    testWindow.__rememberedOrganizationReads = 0
    testWindow.__rememberedOrganizationWrites = []
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (...args) => {
      const response = await originalFetch(...args)
      testWindow.__startupFetchesSettled += 1
      return response
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        invoke: async (channel: string, input?: { organizationId?: string }) => {
          if (channel === 'organization:get-remembered-active-organization') {
            testWindow.__rememberedOrganizationReads += 1
            return { organizationId: null }
          }
          if (channel === 'organization:set-remembered-active-organization') {
            if (input?.organizationId) {
              testWindow.__rememberedOrganizationWrites.push(input.organizationId)
            }
            return undefined
          }
          throw new Error(`Unexpected component-test IPC Channel: ${channel}`)
        }
      }
    })
  })
}

test('a failed startup prerequisite stops restoring in a recoverable phase', async ({ mount }) => {
  const component = await mount(<FailedStartupPrerequisiteStory />)

  await expect(component).toHaveText('failed')
})

test('a persistent startup failure presents feedback and one retry action', async ({ mount }) => {
  const component = await mount(<StartupFailureStory />)

  await expect(
    component.getByRole('heading', { name: "We couldn't restore your workspace" })
  ).toBeVisible()
  await expect(component.getByText('Check your connection and try again.')).toBeVisible()
  await component.getByRole('button', { name: 'Try again' }).click()
  await expect(component.getByLabel('Startup retry count')).toHaveText('1')
})

test('a manual retry recovers after a transient startup failure', async ({ mount, page }) => {
  await installSuccessfulStartupBoundaries(page)
  const component = await mount(<StartupRecoveryStory />)

  await expect(
    component.getByRole('heading', { name: "We couldn't restore your workspace" })
  ).toBeVisible()
  await component.getByRole('button', { name: 'Try again' }).click()
  await expect(component.getByLabel('Organization startup phase')).toHaveText('ready')
  await expect(component.getByLabel('Profile prerequisite attempts')).toHaveText('2')
})

test('a successful startup still becomes ready on its first attempt', async ({ mount, page }) => {
  await installSuccessfulStartupBoundaries(page)
  const component = await mount(<StartupRecoveryStory failFirst={false} />)

  await expect(component.getByLabel('Organization startup phase')).toHaveText('ready')
  await expect(component.getByLabel('Profile prerequisite attempts')).toHaveText('1')
})

test('a persistent startup failure returns to feedback after a manual retry', async ({
  mount,
  page
}) => {
  await installSuccessfulStartupBoundaries(page)
  const component = await mount(<StartupRecoveryStory persistent />)

  await expect(component.getByLabel('Profile prerequisite attempts')).toHaveText('1')
  await component.getByRole('button', { name: 'Try again' }).click()
  await expect(component.getByLabel('Profile prerequisite attempts')).toHaveText('2')
  await expect(
    component.getByRole('heading', { name: "We couldn't restore your workspace" })
  ).toBeVisible()
})

test('an unmounted provider ignores a stale startup result', async ({ mount, page }) => {
  await installSessionAwareStartupBoundaries(page)
  const component = await mount(<StaleStartupResultStory />)
  const lifecycleCounts = (): Promise<readonly [number, number]> =>
    page.evaluate(() => {
      const testWindow = window as typeof window & {
        __startupFetchesSettled: number
        __rememberedOrganizationReads: number
      }
      return [testWindow.__startupFetchesSettled, testWindow.__rememberedOrganizationReads] as const
    })

  await expect.poll(lifecycleCounts).toEqual([2, 1])
  await component.getByRole('button', { name: 'Unmount provider' }).click()
  await expect(component.getByLabel('Provider state')).toHaveText('unmounted')
  await component.getByRole('button', { name: 'Release old Profile' }).click()
  await expect(component.getByLabel('Old Profile state')).toHaveText('released')
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )

  expect(
    await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __rememberedOrganizationWrites: string[]
      }
      return testWindow.__rememberedOrganizationWrites
    })
  ).toEqual([])
})

test('a previous Session cannot overwrite the new Session startup result', async ({
  mount,
  page
}) => {
  await installSessionAwareStartupBoundaries(page)
  const component = await mount(<StaleStartupResultStory />)
  const lifecycleCounts = (): Promise<readonly [number, number]> =>
    page.evaluate(() => {
      const testWindow = window as typeof window & {
        __startupFetchesSettled: number
        __rememberedOrganizationReads: number
      }
      return [testWindow.__startupFetchesSettled, testWindow.__rememberedOrganizationReads] as const
    })

  await expect.poll(lifecycleCounts).toEqual([2, 1])
  await component.getByRole('button', { name: 'Switch Session' }).click()
  await expect(component.getByLabel('Active Organization')).toHaveText('new-organization')
  await expect.poll(lifecycleCounts).toEqual([4, 2])
  await component.getByRole('button', { name: 'Release old Profile' }).click()
  await expect(component.getByLabel('Old Profile state')).toHaveText('released')
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )

  await expect(component.getByLabel('Active Organization')).toHaveText('new-organization')
  expect(
    await page.evaluate(() => {
      const testWindow = window as typeof window & {
        __rememberedOrganizationWrites: string[]
      }
      return testWindow.__rememberedOrganizationWrites
    })
  ).toEqual(['new-organization'])
})
