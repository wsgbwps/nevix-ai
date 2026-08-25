import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp, signOutFromUserMenu } from '../helpers/electron-app'
import {
  createTeamUser,
  expectSessionAccepted,
  loginOutsideDesktop,
  readIdentityServerConfig,
  uniqueIdentity
} from './helpers/identity-server'

const identityServer = readIdentityServerConfig()

test(
  'a configured build starts at the localized unauthenticated boundary',
  { tag: '@smoke' },
  async () => {
    test.skip(
      !process.env.NEVIX_TEST_SERVER_URL,
      'requires the configured build produced by the E2E command'
    )

    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-boundary-'))

    try {
      const launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['en-US'],
        serverUrl: identityServer!.serverUrl
      })

      try {
        await expect(
          launched.page.getByRole('heading', { name: 'Initializing authentication' })
        ).toBeVisible()
        await expect(
          launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
        ).toBeVisible()
        await expect(launched.page.getByLabel('Email')).toBeVisible()
        await expect(launched.page.getByLabel('Password')).toBeVisible()
        await expect(launched.page.getByRole('button', { name: 'Sign in' })).toBeEnabled()
        await expect(
          launched.page.getByText('We recommend using 12 or more characters.')
        ).toHaveCount(0)

        // The brand cover panel only renders at wide widths; the form stays usable when narrow.
        // The default window is wide enough to show the panel, so the narrow assertion pins the
        // viewport explicitly instead of depending on the window's default bounds.
        await launched.page.setViewportSize({ width: 900, height: 670 })
        await expect(launched.page.locator('aside')).toBeHidden()
        await launched.page.setViewportSize({ width: 1280, height: 800 })
        await expect(launched.page.locator('aside')).toBeVisible()
        await launched.page.getByLabel('Email').isVisible()
        await launched.page.setViewportSize({ width: 900, height: 670 })
        await expect(launched.page.locator('aside')).toBeHidden()

        await expect(
          launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
        ).toHaveCount(0)
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)

test('a User signs in once and enters the authenticated app shell', { tag: '@smoke' }, async () => {
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const identity = uniqueIdentity('verified-login')
  await createTeamUser(identityServer, identity, 'Verified Login')
  // The forced first-login change is covered by its own spec; this boundary test stabilizes the
  // password over raw HTTP so the Desktop sign-in lands directly in the shell.
  const setupGrant = await loginOutsideDesktop(identityServer, identity)
  await completeFirstLoginChangeOutsideDesktop(identityServer, identity, setupGrant.token)

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-login-'))

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })

    try {
      let loginRequests = 0
      await launched.page.route('**/identity/auth/login', async (route) => {
        loginRequests += 1
        await route.continue()
      })

      await launched.page.getByLabel('Email').fill(identity.email)
      await launched.page.getByLabel('Password').fill(identity.password)
      await launched.page.getByRole('button', { name: 'Sign in' }).click()

      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      await expect(launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toHaveCount(
        0
      )
      expect(loginRequests).toBe(1)
      expect(
        await launched.page.evaluate(async () => ({
          localStorageKeys: Object.keys(localStorage),
          indexedDatabaseNames: (await indexedDB.databases())
            .map((database) => database.name)
            .filter((name): name is string => name !== undefined)
        }))
      ).toEqual({
        localStorageKeys: [],
        indexedDatabaseNames: []
      })
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('sign-out revokes only the Desktop session and reopening stays signed out', async () => {
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const identity = uniqueIdentity('local-signout')
  await createTeamUser(identityServer, identity)
  // A second device session proves the Desktop sign-out only revokes the Desktop session; the
  // forced first-login change is completed over raw HTTP so the Desktop sign-in lands in the shell.
  const setupGrant = await loginOutsideDesktop(identityServer, identity)
  await completeFirstLoginChangeOutsideDesktop(identityServer, identity, setupGrant.token)
  const stableGrant = await loginOutsideDesktop(identityServer, identity)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-signout-'))

  try {
    let launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })

    try {
      await launched.page.getByLabel('Email').fill(identity.email)
      await launched.page.getByLabel('Password').fill(identity.password)
      await launched.page.getByRole('button', { name: 'Sign in' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()

      const logoutRequest = launched.page.waitForRequest(
        (request) => request.method() === 'POST' && request.url().endsWith('/identity/auth/logout')
      )
      await signOutFromUserMenu(launched.page)
      await logoutRequest
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expect(launched.page.getByLabel('Email')).toHaveValue(identity.email)
      await expect(launched.page.getByLabel('Password')).toBeFocused()
    } finally {
      await launched.electronApp.close()
    }

    // The other device's session survived the Desktop sign-out.
    await expectSessionAccepted(identityServer, stableGrant.token, true)

    launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toHaveCount(0)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

/**
 * Completes the forced first-login change over raw HTTP so a test account reaches a stable,
 * reusable password without driving the Desktop UI for it.
 */
async function completeFirstLoginChangeOutsideDesktop(
  config: NonNullable<typeof identityServer>,
  identity: { readonly password: string },
  token: string
): Promise<void> {
  const response = await fetch(new URL('/identity/auth/change-password', config.serverUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      current_password: identity.password,
      new_password: identity.password
    })
  })
  expect(response.status, await response.clone().text()).toBe(200)
}
