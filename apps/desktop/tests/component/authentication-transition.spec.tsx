import { expect, test } from '@playwright/experimental-ct-react'
import type { Page } from '@playwright/test'
import { AuthenticationTransitionStory } from './fixtures/authentication-transition.story'

const authoritativeEmail = 'remembered-transition@example.com'

async function installAuthenticationBoundaries(page: Page): Promise<void> {
  await page.route(
    'https://component-test.supabase.co/auth/v1/token?grant_type=password',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          access_token: 'component-test-access-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'component-test-refresh-token',
          user: {
            id: '00000000-0000-4000-8000-000000000053',
            aud: 'authenticated',
            role: 'authenticated',
            email: authoritativeEmail,
            email_confirmed_at: '2026-08-14T00:00:00.000Z',
            phone: '',
            confirmed_at: '2026-08-14T00:00:00.000Z',
            last_sign_in_at: '2026-08-14T00:00:00.000Z',
            app_metadata: { provider: 'email', providers: ['email'] },
            user_metadata: {},
            identities: [],
            created_at: '2026-08-14T00:00:00.000Z',
            updated_at: '2026-08-14T00:00:00.000Z',
            is_anonymous: false
          }
        })
      })
  )
  await page.route('https://component-test.supabase.co/auth/v1/logout?scope=local', (route) =>
    route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } })
  )

  await page.evaluate(() => {
    let releaseClearFailure!: (result: { outcome: 'clear-failed' }) => void
    const pendingClear = new Promise<{ outcome: 'clear-failed' }>((resolve) => {
      releaseClearFailure = resolve
    })
    let releaseReplacementFailure!: (result: { outcome: 'memory-only' }) => void
    const pendingReplacement = new Promise<{ outcome: 'memory-only' }>((resolve) => {
      releaseReplacementFailure = resolve
    })
    const testWindow = window as typeof window & {
      releaseRememberedEmailClearFailure: () => void
      releaseRememberedEmailReplacementFailure: () => void
    }
    testWindow.releaseRememberedEmailClearFailure = () => {
      releaseClearFailure({ outcome: 'clear-failed' })
    }
    testWindow.releaseRememberedEmailReplacementFailure = () => {
      releaseReplacementFailure({ outcome: 'memory-only' })
    }

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        invoke: async (channel: string) => {
          if (channel === 'authentication:read-session') return { outcome: 'empty' }
          if (channel === 'authentication:read-remembered-email') {
            return {
              outcome: 'email',
              email: 'previous@example.com',
              persistence: 'secure'
            }
          }
          if (channel === 'authentication:clear-remembered-email') return pendingClear
          if (channel === 'authentication:replace-remembered-email') return pendingReplacement
          if (channel === 'authentication:replace-session') return { outcome: 'persisted' }
          if (channel === 'authentication:clear-session') return undefined
          throw new Error(`Unexpected component-test IPC Channel: ${channel}`)
        }
      }
    })
  })
}

test('a clear failure in the authentication transition window reaches the mounted surface once', async ({
  mount,
  page
}) => {
  await installAuthenticationBoundaries(page)
  const component = await mount(<AuthenticationTransitionStory />)
  const persistenceNotice = component.getByText(
    'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
  )

  await expect(component.getByLabel('Authentication status')).toHaveText('unauthenticated')
  await component
    .getByRole('button', { name: 'Enter authenticated shell before clear fails' })
    .click()

  await expect(component.getByLabel('Authentication status')).toHaveText('authenticated')
  await expect(persistenceNotice).toBeVisible()
  await expect(persistenceNotice).toHaveCount(1)
})

test('a replacement failure after leaving the authenticated shell reaches login once', async ({
  mount,
  page
}) => {
  await installAuthenticationBoundaries(page)
  const component = await mount(<AuthenticationTransitionStory />)
  const persistenceNotice = component.getByText(
    'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
  )

  await expect(component.getByLabel('Authentication status')).toHaveText('unauthenticated')
  await component
    .getByRole('button', { name: 'Leave authenticated shell before replacement fails' })
    .click()

  await expect(component.getByLabel('Authentication status')).toHaveText('unauthenticated')
  await expect(persistenceNotice).toBeVisible()
  await expect(persistenceNotice).toHaveCount(1)
})
