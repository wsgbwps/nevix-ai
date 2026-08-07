import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Session } from '@supabase/supabase-js'
import { launchTestApp, signOutFromUserMenu } from '../helpers/electron-app'
import {
  createAuthUser,
  deleteAuthUser,
  readAuthHarnessConfig,
  revokeSessionOutsideDesktop,
  uniqueAuthIdentity
} from './helpers/supabase-auth'
import { seedOrganizationWithMembership } from '../organization/helpers/organization-seed'

const authHarness = readAuthHarnessConfig()
const SESSION_FILE_NAME = 'authentication-session.enc'

test('a securely persisted Session refreshes before restore, survives an outage, and logout deletes it', async () => {
  test.setTimeout(90_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('session-restore')
  const userId = await createAuthUser(authHarness, identity, true)
  // Signing in must reach the App Shell, so the User needs an Organization to auto-enter.
  await seedOrganizationWithMembership(userId, { name: 'Session Restore Org' })
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-restore-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)

  try {
    let launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      test.skip(
        !(await hasSecurePersistenceBackend(launched.electronApp)),
        'requires a native Keychain, DPAPI, or Secret Service backend'
      )

      const session = await signInAndReadSession(launched.page, identity)
      const originalEnvelope = await readFile(sessionPath, 'utf8')
      expectEncryptedEnvelope(originalEnvelope, identity.email, session)
    } finally {
      await launched.electronApp.close()
    }

    const envelopeBeforeRetry = await readFile(sessionPath, 'utf8')
    launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      offline: true
    })
    try {
      await expect(
        launched.page.getByRole('heading', { name: 'Your session could not be restored yet' })
      ).toBeVisible({ timeout: 35_000 })
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toHaveCount(0)
      expect(await readFile(sessionPath, 'utf8')).toBe(envelopeBeforeRetry)

      await launched.electronApp.evaluate(({ session }) => {
        session.defaultSession.disableNetworkEmulation()
      })
      await launched.page.unrouteAll({ behavior: 'wait' })
      let refreshRequests = 0
      await launched.page.route('**/auth/v1/token?grant_type=refresh_token', async (route) => {
        refreshRequests += 1
        await route.continue()
      })
      await launched.page.getByRole('button', { name: 'Try again' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      expect(refreshRequests).toBe(1)

      const rotatedEnvelope = await readFile(sessionPath, 'utf8')
      expect(rotatedEnvelope).not.toBe(envelopeBeforeRetry)
      expectEncryptedEnvelope(rotatedEnvelope, identity.email)

      const localLogoutRequest = launched.page.waitForRequest(
        (request) =>
          request.method() === 'POST' &&
          request.url().includes('/auth/v1/logout') &&
          request.url().includes('scope=local')
      )
      await signOutFromUserMenu(launched.page)
      await localLogoutRequest
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expectFileMissing(sessionPath)
    } finally {
      await launched.electronApp.close()
    }

    launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
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

test('a revoked refresh Session is cleared and returns to the localized login boundary', async () => {
  test.setTimeout(60_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('revoked-restore')
  const userId = await createAuthUser(authHarness, identity, true)
  await seedOrganizationWithMembership(userId, { name: 'Revoked Restore Org' })
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-revoked-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    let session: Session
    try {
      test.skip(
        !(await hasSecurePersistenceBackend(launched.electronApp)),
        'requires a native Keychain, DPAPI, or Secret Service backend'
      )
      session = await signInAndReadSession(launched.page, identity)
      await expect.poll(() => fileExists(sessionPath)).toBe(true)
    } finally {
      await launched.electronApp.close()
    }

    await revokeSessionOutsideDesktop(authHarness, session.access_token)

    const relaunched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await expect(
        relaunched.page.getByText('Your session is no longer valid. Sign in again.')
      ).toBeVisible()
      await expect(
        relaunched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toHaveCount(0)
      await expectFileMissing(sessionPath)
    } finally {
      await relaunched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, userId)
  }
})

test('corrupt, unknown, random, and malformed encrypted Session envelopes are terminal and deleted', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SUPABASE_URL,
    'requires the configured build produced by the Auth test command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-corrupt-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)
  let encryptedMalformedSession: string | undefined

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      if (await hasSecurePersistenceBackend(launched.electronApp)) {
        encryptedMalformedSession = await launched.electronApp.evaluate(({ safeStorage }) =>
          safeStorage.encryptString('{"access_token":"incomplete"}').toString('base64')
        )
      }
    } finally {
      await launched.electronApp.close()
    }

    // Structurally valid envelopes are only terminal when a secure backend can attempt
    // decryption; without one the store reports storage-unavailable and keeps the file, so
    // those cases run only alongside the backend-encrypted malformed Session (Issue 06).
    const cases = [
      '{"version":1,"ciphertext":',
      JSON.stringify({ version: 999, ciphertext: 'dW5rbm93bi12ZXJzaW9u' }),
      ...(encryptedMalformedSession
        ? [
            JSON.stringify({ version: 1, ciphertext: 'bm90LWEtc2FmZS1zdG9yYWdlLXBheWxvYWQ=' }),
            JSON.stringify({ version: 1, ciphertext: encryptedMalformedSession })
          ]
        : [])
    ]

    for (const envelope of cases) {
      await mkdir(dirname(sessionPath), { recursive: true })
      await writeFile(sessionPath, envelope, 'utf8')

      const relaunched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
      try {
        await expect(
          relaunched.page.getByText('Your session is no longer valid. Sign in again.')
        ).toBeVisible()
        await expect(
          relaunched.page.getByRole('heading', { name: 'Create with Nevix AI' })
        ).toHaveCount(0)
        await expectFileMissing(sessionPath)
      } finally {
        await relaunched.electronApp.close()
      }
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('a failed Session replace preserves the previous envelope and clear removes pending state', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-write-failure-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)
  const pendingPath = `${sessionPath}.pending`
  const firstSession = JSON.stringify({
    access_token: 'first-access-token',
    refresh_token: 'first-refresh-token',
    token_type: 'bearer',
    expires_at: 4_102_444_800,
    user: { id: 'write-failure-test-user' }
  })
  const secondSession = firstSession.replaceAll('first-', 'second-')

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      test.skip(
        !(await hasSecurePersistenceBackend(launched.electronApp)),
        'requires a native Keychain, DPAPI, or Secret Service backend'
      )

      const written = await invokeAuthenticationChannel(
        launched.page,
        'authentication:replace-session',
        { session: firstSession }
      )
      expect(written).toEqual({ outcome: 'persisted' })
      const originalEnvelope = await readFile(sessionPath, 'utf8')

      // A directory at the pending path makes the next envelope write fail before the atomic rename.
      await mkdir(pendingPath)
      const failed = await invokeAuthenticationChannel(
        launched.page,
        'authentication:replace-session',
        { session: secondSession }
      )
      expect(failed).toEqual({ outcome: 'unavailable' })

      expect(await readFile(sessionPath, 'utf8')).toBe(originalEnvelope)
      expect(
        await invokeAuthenticationChannel(launched.page, 'authentication:read-session')
      ).toEqual({ outcome: 'session', session: firstSession })

      await rm(pendingPath, { recursive: true, force: true })
      await writeFile(pendingPath, 'stale-pending-envelope', 'utf8')
      await invokeAuthenticationChannel(launched.page, 'authentication:clear-session')
      await expectFileMissing(sessionPath)
      await expectFileMissing(pendingPath)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('unavailable secure storage keeps only the runtime Session and offline logout still ends local access', async () => {
  test.setTimeout(60_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('unavailable-storage')
  const userId = await createAuthUser(authHarness, identity, true)
  await seedOrganizationWithMembership(userId, { name: 'Unavailable Storage Org' })
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-unavailable-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)
  const environment = { NEVIX_TEST_UNAVAILABLE_SECURE_STORAGE: '1' }

  try {
    let launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      environment
    })
    try {
      await signInAndReadSession(launched.page, identity)
      await expect(
        launched.page.getByText(
          'This device cannot store your session securely, so you will sign in again after closing the application.'
        )
      ).toBeVisible()
      await expectFileMissing(sessionPath)

      await launched.electronApp.evaluate(({ session }) => {
        session.defaultSession.enableNetworkEmulation({ offline: true })
      })
      await launched.page.route('**/auth/v1/logout?scope=local', (route) =>
        route.abort('internetdisconnected')
      )
      await signOutFromUserMenu(launched.page)
      await expect(
        launched.page.getByText(
          'This device is signed out. Revoking the session on the server may be delayed.'
        )
      ).toBeVisible()
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expectFileMissing(sessionPath)
    } finally {
      await launched.electronApp.close()
    }

    launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      environment
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

test('a secure-storage outage keeps the encrypted Session envelope and restore succeeds after recovery', async () => {
  test.setTimeout(90_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('storage-outage')
  const userId = await createAuthUser(authHarness, identity, true)
  await seedOrganizationWithMembership(userId, { name: 'Storage Outage Org' })
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-outage-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)

  try {
    let launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      test.skip(
        !(await hasSecurePersistenceBackend(launched.electronApp)),
        'requires a native Keychain, DPAPI, or Secret Service backend'
      )
      await signInAndReadSession(launched.page, identity)
      await expect.poll(() => fileExists(sessionPath)).toBe(true)
    } finally {
      await launched.electronApp.close()
    }

    const envelopeBeforeOutage = await readFile(sessionPath, 'utf8')
    launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      environment: { NEVIX_TEST_UNAVAILABLE_SECURE_STORAGE: '1' }
    })
    try {
      await expect(
        launched.page.getByRole('heading', { name: 'Your session could not be restored yet' })
      ).toBeVisible()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toHaveCount(0)
      expect(await readFile(sessionPath, 'utf8')).toBe(envelopeBeforeOutage)
    } finally {
      await launched.electronApp.close()
    }

    launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible({ timeout: 35_000 })
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, userId)
  }
})

test('a corrupt envelope stays terminal and deleted even while secure storage is unavailable', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SUPABASE_URL,
    'requires the configured build produced by the Auth test command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-corrupt-outage-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)

  try {
    await mkdir(dirname(sessionPath), { recursive: true })
    await writeFile(
      sessionPath,
      JSON.stringify({ version: 999, ciphertext: 'dW5rbm93bi12ZXJzaW9u' }),
      'utf8'
    )

    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      environment: { NEVIX_TEST_UNAVAILABLE_SECURE_STORAGE: '1' }
    })
    try {
      await expect(
        launched.page.getByText('Your session is no longer valid. Sign in again.')
      ).toBeVisible()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toHaveCount(0)
      await expectFileMissing(sessionPath)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('Linux basic_text is treated as unavailable and never creates a Session file', async () => {
  test.setTimeout(60_000)
  test.skip(process.platform !== 'linux', 'Electron basic_text exists only on Linux')
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('basic-text-storage')
  const userId = await createAuthUser(authHarness, identity, true)
  await seedOrganizationWithMembership(userId, { name: 'Basic Text Org' })
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-basic-text-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      environment: { NEVIX_TEST_FORCE_BASIC_TEXT_STORAGE: '1' }
    })
    try {
      expect(
        await launched.electronApp.evaluate(({ safeStorage }) =>
          safeStorage.getSelectedStorageBackend()
        )
      ).toBe('basic_text')
      await signInAndReadSession(launched.page, identity)
      await expect(
        launched.page.getByText(
          'This device cannot store your session securely, so you will sign in again after closing the application.'
        )
      ).toBeVisible()
      await expectFileMissing(sessionPath)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, userId)
  }
})

async function signInAndReadSession(
  page: Page,
  identity: { readonly email: string; readonly password: string }
): Promise<Session> {
  await expect(page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible()
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/auth/v1/token?grant_type=password')
  )
  await page.getByLabel('Email').fill(identity.email)
  await page.getByLabel('Password').fill(identity.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  const response = await responsePromise
  const session = (await response.json()) as Session
  await expect(page.getByRole('heading', { name: 'Create with Nevix AI' })).toBeVisible()
  return session
}

async function invokeAuthenticationChannel(
  page: Page,
  channel: string,
  request?: unknown
): Promise<unknown> {
  return page.evaluate(
    ({ channel, request }) => {
      const bridge = window as unknown as {
        api: { invoke: (channel: string, request?: unknown) => Promise<unknown> }
      }
      return request === undefined
        ? bridge.api.invoke(channel)
        : bridge.api.invoke(channel, request)
    },
    { channel, request }
  )
}

async function hasSecurePersistenceBackend(electronApp: ElectronApplication): Promise<boolean> {
  return electronApp.evaluate(({ safeStorage }) => {
    if (!safeStorage.isEncryptionAvailable()) return false
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
  })
}

function expectEncryptedEnvelope(envelope: string, email: string, session?: Session): void {
  const parsed = JSON.parse(envelope) as Record<string, unknown>
  expect(Object.keys(parsed).sort()).toEqual(['ciphertext', 'version'])
  expect(parsed.version).toBe(1)
  expect(typeof parsed.ciphertext).toBe('string')
  expect(envelope).not.toContain(email)
  expect(envelope).not.toContain('"access_token"')
  expect(envelope).not.toContain('"refresh_token"')
  if (session) {
    expect(envelope).not.toContain(session.access_token)
    expect(envelope).not.toContain(session.refresh_token)
    expect(envelope).not.toContain(JSON.stringify(session))
  }
}

async function expectFileMissing(path: string): Promise<void> {
  await expect.poll(() => fileExists(path)).toBe(false)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
