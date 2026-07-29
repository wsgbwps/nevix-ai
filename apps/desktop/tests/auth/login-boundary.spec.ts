import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'
import {
  createAuthUser,
  deleteAuthUser,
  readAuthHarnessConfig,
  refreshOutsideDesktop,
  signInOutsideDesktop,
  uniqueAuthIdentity
} from './helpers/supabase-auth'

const authHarness = readAuthHarnessConfig()

test('a configured build starts at the localized unauthenticated boundary', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SUPABASE_URL,
    'requires the configured build produced by the Auth test command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-boundary-'))

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US']
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
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toHaveCount(0)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('a verified User signs in once and enters the authenticated app shell', async () => {
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('verified-login')
  const userId = await createAuthUser(authHarness, identity, true)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-login-'))

  try {
    let launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US']
    })

    try {
      let releaseRequest: (() => void) | undefined
      const requestMayContinue = new Promise<void>((resolve) => {
        releaseRequest = resolve
      })
      let observeRequest: (() => void) | undefined
      const requestObserved = new Promise<void>((resolve) => {
        observeRequest = resolve
      })
      let passwordRequestCount = 0

      await launched.page.route('**/auth/v1/token?grant_type=password', async (route) => {
        passwordRequestCount += 1
        observeRequest?.()
        await requestMayContinue
        await route.continue()
      })

      await launched.page.getByLabel('Email').fill(identity.email)
      await launched.page.getByLabel('Password').fill(identity.password)
      await launched.page.getByRole('button', { name: 'Sign in' }).click()
      await requestObserved

      await expect(launched.page.getByRole('button', { name: 'Signing in…' })).toBeDisabled()
      expect(passwordRequestCount).toBe(1)

      releaseRequest?.()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      await expect(launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toHaveCount(
        0
      )
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

    launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US']
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
    await deleteAuthUser(authHarness, userId)
  }
})

test('unknown, unverified, and incorrect credentials share one safe error', async () => {
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const verifiedIdentity = uniqueAuthIdentity('wrong-password')
  const unverifiedIdentity = uniqueAuthIdentity('unverified-login')
  const verifiedUserId = await createAuthUser(authHarness, verifiedIdentity, true)
  const unverifiedUserId = await createAuthUser(authHarness, unverifiedIdentity, false)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-errors-'))

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US']
    })

    try {
      const attempts = [
        uniqueAuthIdentity('unknown-login'),
        { email: unverifiedIdentity.email, password: unverifiedIdentity.password },
        { email: verifiedIdentity.email, password: `${verifiedIdentity.password}-wrong` }
      ]

      for (const attempt of attempts) {
        await launched.page.getByLabel('Email').fill(attempt.email)
        await launched.page.getByLabel('Password').fill(attempt.password)
        await launched.page.getByRole('button', { name: 'Sign in' }).click()
        await expect(
          launched.page.getByRole('alert').filter({ hasText: 'Email or password is incorrect' })
        ).toBeVisible()
        await expect(
          launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
        ).toHaveCount(0)
      }
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await Promise.all([
      deleteAuthUser(authHarness, verifiedUserId),
      deleteAuthUser(authHarness, unverifiedUserId)
    ])
  }
})

test('sign-out revokes only the Desktop Session and reopening stays signed out', async () => {
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('local-signout')
  const userId = await createAuthUser(authHarness, identity, true)
  const otherSession = await signInOutsideDesktop(authHarness, identity)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-signout-'))

  try {
    let launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US']
    })

    try {
      await launched.page.getByLabel('Email').fill(identity.email)
      await launched.page.getByLabel('Password').fill(identity.password)
      await launched.page.getByRole('button', { name: 'Sign in' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()

      const localLogoutRequest = launched.page.waitForRequest(
        (request) =>
          request.method() === 'POST' &&
          request.url().includes('/auth/v1/logout') &&
          request.url().includes('scope=local')
      )
      await launched.page.getByRole('button', { name: 'Sign out of this device' }).click()
      await localLogoutRequest
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
    } finally {
      await launched.electronApp.close()
    }

    await refreshOutsideDesktop(authHarness, otherSession.refresh_token)

    launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US']
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
    await deleteAuthUser(authHarness, userId)
  }
})
