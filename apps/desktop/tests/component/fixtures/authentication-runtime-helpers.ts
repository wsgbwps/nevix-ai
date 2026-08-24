import { expect, type Page } from '@playwright/test'

/** A scripted result that stays pending until the test settles it by index. */
export const DEFER = { __defer: true } as const

export type RuntimeAdapter = 'go' | 'sessions' | 'remembered'

export interface ModuleUser {
  readonly id: string
  readonly email: string
  readonly displayName: string
  readonly role: 'admin' | 'member'
  readonly mustChangePassword: boolean
}

export interface ModuleSession {
  readonly token: string
  readonly expiresAt: string
  readonly user: ModuleUser
}

export const memberUser: ModuleUser = {
  id: '00000000-0000-4000-8000-000000000101',
  email: 'member@example.com',
  displayName: 'member',
  role: 'member',
  mustChangePassword: false
}

export const adminUser: ModuleUser = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'first.admin@example.com',
  displayName: 'first admin',
  role: 'admin',
  mustChangePassword: false
}

export function memberSession(user: ModuleUser = memberUser): ModuleSession {
  return {
    token: `opaque-token-${user.role}`,
    expiresAt: '2027-01-01T00:00:00Z',
    user
  }
}

/** Installs the preset consumed once when the story creates its adapters. */
export async function prepareAuthenticationRuntime(
  page: Page,
  preset: Record<string, unknown> = {}
): Promise<void> {
  await page.evaluate((next) => {
    window.__authRuntimePreset = next
  }, preset)
}

export async function enqueue(
  page: Page,
  adapter: RuntimeAdapter,
  operation: string,
  result: unknown
): Promise<number> {
  return page.evaluate(
    ({ a, o, r }) => {
      const test = window.__authRuntimeTest
      if (test === undefined) throw new Error('Authentication module controls are missing.')
      if (r !== null && typeof r === 'object' && (r as { __defer?: boolean }).__defer === true) {
        const deferred = test.makeDeferred()
        test[a].enqueue(o, deferred.promise)
        return deferred.index
      }
      test[a].enqueue(o, r)
      return -1
    },
    { a: adapter, o: operation, r: result }
  )
}

export async function settle(page: Page, index: number, value: unknown): Promise<void> {
  await page.evaluate(
    ({ i, v }) => {
      window.__authRuntimeTest?.settle(i, v)
    },
    { i: index, v: value }
  )
}

export async function adapterCalls(
  page: Page,
  adapter: RuntimeAdapter
): Promise<readonly unknown[]> {
  return page.evaluate((a) => window.__authRuntimeTest?.calls[a] ?? [], adapter)
}

/** The login form is the settled unauthenticated surface for an initialized instance. */
export async function expectLoginBoundary(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible()
  await expect(page.getByTestId('session-status')).toHaveText('unavailable')
}
