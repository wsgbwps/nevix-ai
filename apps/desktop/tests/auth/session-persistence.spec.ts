import { expect, test, type Page } from '@playwright/test'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  hasSecurePersistenceBackend,
  launchTestApp,
  signOutFromUserMenu
} from '../helpers/electron-app'
import {
  createStableTeamUser,
  readIdentityServerConfig,
  resetTeamUserPassword,
  uniqueIdentity,
  type LoginGrant
} from './helpers/identity-server'

const identityServer = readIdentityServerConfig()
const SESSION_FILE_NAME = 'authentication-session.enc'
const RESTORE_BOUNDARY_REMEMBERED_EMAIL = 'restore-boundary@example.com'

test('a securely persisted session restores without a fresh login, survives an outage, and logout deletes it', async () => {
  test.setTimeout(90_000)
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const identity = uniqueIdentity('session-restore')
  await createStableTeamUser(identityServer, identity)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-restore-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)

  try {
    let launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      test.skip(
        !(await hasSecurePersistenceBackend(launched.electronApp)),
        'requires a native Keychain, DPAPI, or Secret Service backend'
      )

      const grant = await signInAndReadGrant(launched.page, identity)
      const originalEnvelope = await readFile(sessionPath, 'utf8')
      expectEncryptedEnvelope(originalEnvelope, identity.email, grant)
      const storedPayload = await launched.electronApp.evaluate(({ safeStorage }, envelope) => {
        const parsed = JSON.parse(envelope) as { ciphertext: string }
        return JSON.parse(
          safeStorage.decryptString(Buffer.from(parsed.ciphertext, 'base64'))
        ) as Record<string, unknown>
      }, originalEnvelope)
      expect(Object.keys(storedPayload).sort()).toEqual(['expires_at', 'token', 'user'])
      expect(Object.keys(storedPayload.user as Record<string, unknown>).sort()).toEqual([
        'email',
        'id'
      ])

      await launched.electronApp.evaluate(() => {
        process.env.NEVIX_TEST_UNAVAILABLE_SECURE_STORAGE = '1'
      })
      expect(
        await invokeAuthenticationChannel(launched.page, 'authentication:replace-session', {
          session: JSON.stringify(grant)
        })
      ).toEqual({ outcome: 'unavailable' })
      expect(await readFile(sessionPath, 'utf8')).toBe(originalEnvelope)
      await launched.electronApp.evaluate(() => {
        delete process.env.NEVIX_TEST_UNAVAILABLE_SECURE_STORAGE
      })
      expect(
        await invokeAuthenticationChannel(
          launched.page,
          'authentication:replace-remembered-email',
          { email: RESTORE_BOUNDARY_REMEMBERED_EMAIL }
        )
      ).toEqual({ outcome: 'persisted' })
    } finally {
      await launched.electronApp.close()
    }

    const envelopeBeforeRetry = await readFile(sessionPath, 'utf8')
    launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl,
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
      let meRequests = 0
      await launched.page.route('**/identity/users/me', async (route) => {
        meRequests += 1
        await route.continue()
      })
      await launched.page.getByRole('button', { name: 'Try again' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      // Restore verifies the opaque token against /me exactly once; the stored envelope is
      // never rewritten because nothing rotates an opaque token.
      expect(meRequests).toBe(1)
      expect(await readFile(sessionPath, 'utf8')).toBe(envelopeBeforeRetry)
      expect(
        await invokeAuthenticationChannel(launched.page, 'authentication:read-remembered-email')
      ).toEqual({
        outcome: 'email',
        email: RESTORE_BOUNDARY_REMEMBERED_EMAIL,
        persistence: 'secure'
      })

      const logoutRequest = launched.page.waitForRequest(
        (request) => request.method() === 'POST' && request.url().endsWith('/identity/auth/logout')
      )
      await signOutFromUserMenu(launched.page)
      await logoutRequest
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expect(launched.page.getByLabel('Email')).toHaveValue(RESTORE_BOUNDARY_REMEMBERED_EMAIL)
      await expect(launched.page.getByLabel('Password')).toBeFocused()
      await expectFileMissing(sessionPath)
    } finally {
      await launched.electronApp.close()
    }

    launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expect(launched.page.getByLabel('Email')).toHaveValue(RESTORE_BOUNDARY_REMEMBERED_EMAIL)
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

test('a revoked stored session is cleared and returns to the localized login boundary', async () => {
  test.setTimeout(60_000)
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const identity = uniqueIdentity('revoked-restore')
  const user = await createStableTeamUser(identityServer, identity)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-revoked-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      test.skip(
        !(await hasSecurePersistenceBackend(launched.electronApp)),
        'requires a native Keychain, DPAPI, or Secret Service backend'
      )
      await signInAndReadGrant(launched.page, identity)
      await expect.poll(() => fileExists(sessionPath)).toBe(true)
    } finally {
      await launched.electronApp.close()
    }

    // An Admin password reset revokes every session of the user in the same write transaction.
    await resetTeamUserPassword(identityServer, user.id, 'rotated horse battery staple')

    const relaunched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
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
  }
})

test('corrupt, unknown, random, and malformed encrypted session envelopes are terminal and deleted', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SERVER_URL,
    'requires the configured build produced by the E2E command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-corrupt-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)
  let encryptedMalformedSession: string | undefined

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      if (await hasSecurePersistenceBackend(launched.electronApp)) {
        encryptedMalformedSession = await launched.electronApp.evaluate(({ safeStorage }) =>
          safeStorage.encryptString('{"token":"incomplete"}').toString('base64')
        )
      }
    } finally {
      await launched.electronApp.close()
    }

    // Structurally valid envelopes are only terminal when a secure backend can attempt
    // decryption; without one the store reports storage-unavailable and keeps the file, so
    // those cases run only alongside the backend-encrypted malformed session.
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

      const relaunched = await launchTestApp({
        userDataDir,
        systemLanguages: ['en-US'],
        serverUrl: identityServer!.serverUrl
      })
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

test('a failed session replace preserves the previous envelope and clear removes pending state', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-write-failure-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)
  const pendingPath = `${sessionPath}.pending`
  const firstSession = JSON.stringify({
    token: 'first-opaque-session-token',
    expires_at: '2026-01-01T00:00:00Z',
    user: { id: 'write-failure-test-user', email: 'write-failure@example.com' }
  })
  const secondSession = firstSession.replaceAll('first-', 'second-')

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
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

test('unavailable secure storage keeps only the runtime session and offline logout still ends local access', async () => {
  test.setTimeout(60_000)
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const identity = uniqueIdentity('unavailable-storage')
  await createStableTeamUser(identityServer, identity)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-unavailable-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)
  const environment = { NEVIX_TEST_UNAVAILABLE_SECURE_STORAGE: '1' }

  try {
    let launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl,
      environment
    })
    try {
      await signInAndReadGrant(launched.page, identity)
      await expect(
        launched.page.getByText(
          'This device cannot store your session securely, so you will sign in again after closing the application.'
        )
      ).toBeVisible()
      await expectFileMissing(sessionPath)

      await launched.electronApp.evaluate(({ session }) => {
        session.defaultSession.enableNetworkEmulation({ offline: true })
      })
      await launched.page.route('**/identity/auth/logout', (route) =>
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
      serverUrl: identityServer!.serverUrl,
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
  }
})

test('a secure-storage outage keeps the encrypted session envelope and restore succeeds after recovery', async () => {
  test.setTimeout(90_000)
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const identity = uniqueIdentity('storage-outage')
  await createStableTeamUser(identityServer, identity)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-outage-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)

  try {
    let launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      test.skip(
        !(await hasSecurePersistenceBackend(launched.electronApp)),
        'requires a native Keychain, DPAPI, or Secret Service backend'
      )
      await signInAndReadGrant(launched.page, identity)
      await expect.poll(() => fileExists(sessionPath)).toBe(true)
    } finally {
      await launched.electronApp.close()
    }

    const envelopeBeforeOutage = await readFile(sessionPath, 'utf8')
    launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl,
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

    launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible({ timeout: 35_000 })
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('a corrupt envelope stays terminal and deleted even while secure storage is unavailable', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SERVER_URL,
    'requires the configured build produced by the E2E command'
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
      serverUrl: identityServer!.serverUrl,
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

test('a transient session read failure keeps the envelope and the read recovers after the mode bit is restored', async () => {
  test.setTimeout(90_000)
  test.skip(process.platform === 'win32', 'POSIX mode bits cannot emulate read failure on Windows')
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const identity = uniqueIdentity('read-failure')
  await createStableTeamUser(identityServer, identity)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-read-failure-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      test.skip(
        !(await hasSecurePersistenceBackend(launched.electronApp)),
        'requires a native Keychain, DPAPI, or Secret Service backend'
      )
      await signInAndReadGrant(launched.page, identity)
      await expect.poll(() => fileExists(sessionPath)).toBe(true)
      const envelopeBeforeFailure = await readFile(sessionPath, 'utf8')

      await chmod(sessionPath, 0o000)
      expect(
        await invokeAuthenticationChannel(launched.page, 'authentication:read-session')
      ).toEqual({ outcome: 'storage-unavailable' })

      await chmod(sessionPath, 0o600)
      expect(await readFile(sessionPath, 'utf8')).toBe(envelopeBeforeFailure)

      const restored = await invokeAuthenticationChannel(
        launched.page,
        'authentication:read-session'
      )
      expect(restored).toMatchObject({ outcome: 'session' })
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('Linux basic_text is treated as unavailable and never creates a session file', async () => {
  test.setTimeout(60_000)
  test.skip(process.platform !== 'linux', 'Electron basic_text exists only on Linux')
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const identity = uniqueIdentity('basic-text-storage')
  await createStableTeamUser(identityServer, identity)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-basic-text-'))
  const sessionPath = join(userDataDir, SESSION_FILE_NAME)

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl,
      environment: { NEVIX_TEST_FORCE_BASIC_TEXT_STORAGE: '1' }
    })
    try {
      expect(
        await launched.electronApp.evaluate(({ safeStorage }) =>
          safeStorage.getSelectedStorageBackend()
        )
      ).toBe('basic_text')
      await signInAndReadGrant(launched.page, identity)
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
  }
})

async function signInAndReadGrant(
  page: Page,
  identity: { readonly email: string; readonly password: string }
): Promise<LoginGrant> {
  await expect(page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible()
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().endsWith('/identity/auth/login')
  )
  await page.getByLabel('Email').fill(identity.email)
  await page.getByLabel('Password').fill(identity.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  const response = await responsePromise
  const grant = (await response.json()) as LoginGrant
  await expect(page.getByRole('heading', { name: 'Create with Nevix AI' })).toBeVisible()
  return grant
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

function expectEncryptedEnvelope(envelope: string, email: string, grant?: LoginGrant): void {
  const parsed = JSON.parse(envelope) as Record<string, unknown>
  expect(Object.keys(parsed).sort()).toEqual(['ciphertext', 'version'])
  expect(parsed.version).toBe(1)
  expect(typeof parsed.ciphertext).toBe('string')
  expect(envelope).not.toContain(email)
  expect(envelope).not.toContain('"token"')
  if (grant) {
    expect(envelope).not.toContain(grant.token)
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
