import { expect, test } from '@playwright/test'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hasSecurePersistenceBackend,
  launchTestApp,
  signOutFromUserMenu
} from '../helpers/electron-app'
import {
  createStableTeamUser,
  readIdentityServerConfig,
  uniqueIdentity
} from './helpers/identity-server'

const identityServer = readIdentityServerConfig()
const rememberedEmailFileName = 'authentication-remembered-email.enc'

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

test('clearing Remembered Email is immediate and reselecting does not save unverified input', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SERVER_URL,
    'requires the configured build produced by the E2E command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-clear-'))
  const seededEmail = 'remembered@example.com'
  const unverifiedEmail = 'not-verified@example.com'
  const recordPath = join(userDataDir, rememberedEmailFileName)
  let launched = await launchTestApp({
    userDataDir,
    systemLanguages: ['en-US'],
    serverUrl: identityServer!.serverUrl
  })

  try {
    if (!(await hasSecurePersistenceBackend(launched.electronApp))) {
      await launched.electronApp.close()
      test.skip(true, 'requires Keychain, DPAPI, or Secret Service for native persistence')
    }

    await launched.page.evaluate(
      async (email) => window.api.invoke('authentication:replace-remembered-email', { email }),
      seededEmail
    )
    await expect.poll(() => fileExists(recordPath)).toBe(true)

    await launched.electronApp.close()
    launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    await expect(launched.page.getByLabel('Email')).toHaveValue(seededEmail)

    await launched.page.getByRole('checkbox', { name: 'Remember sign-in address' }).uncheck()
    await expect.poll(() => fileExists(recordPath)).toBe(false)
    await expect(launched.page.getByLabel('Email')).toHaveValue(seededEmail)

    await launched.page.getByRole('checkbox', { name: 'Remember sign-in address' }).check()
    await launched.page.getByLabel('Email').fill(unverifiedEmail)
    await launched.electronApp.close()
    launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })

    await expect(launched.page.getByLabel('Email')).toHaveValue('')
    await expect(launched.page.getByLabel('Email')).toBeFocused()
    await expect(
      launched.page.getByRole('checkbox', { name: 'Remember sign-in address' })
    ).toBeChecked()
  } finally {
    await launched.electronApp.close().catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test(
  'uncheck then recheck serializes clear before the next successful replacement',
  { tag: '@smoke' },
  async () => {
    test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
    if (!identityServer) return

    const identity = uniqueIdentity('remembered-clear-replace-order')
    await createStableTeamUser(identityServer, identity)
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-clear-replace-'))
    const recordPath = join(userDataDir, rememberedEmailFileName)
    let launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl,
      environment: { NEVIX_TEST_REMEMBERED_EMAIL_CLEAR_DELAY_MS: '5000' }
    })

    try {
      if (!(await hasSecurePersistenceBackend(launched.electronApp))) {
        await launched.electronApp.close()
        test.skip(true, 'requires Keychain, DPAPI, or Secret Service for native persistence')
      }

      await launched.page.evaluate(
        async (email) => window.api.invoke('authentication:replace-remembered-email', { email }),
        'previous-clear-order@example.com'
      )
      await launched.page.reload()
      await expect(launched.page.getByLabel('Email')).toHaveValue(
        'previous-clear-order@example.com'
      )

      await launched.page.getByRole('checkbox', { name: 'Remember sign-in address' }).uncheck()
      await launched.page.getByRole('checkbox', { name: 'Remember sign-in address' }).check()
      await launched.page.getByLabel('Email').fill(identity.email)
      await launched.page.getByLabel('Password').fill(identity.password)
      await launched.page.getByRole('button', { name: 'Sign in' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      await expect.poll(() => pathExists(recordPath)).toBe(true)

      await launched.page.waitForTimeout(5500)
      await expect
        .poll(() =>
          launched.page.evaluate(async () =>
            window.api.invoke('authentication:read-remembered-email')
          )
        )
        .toEqual({ outcome: 'email', email: identity.email, persistence: 'secure' })

      await launched.electronApp.close()
      await Promise.all([
        rm(join(userDataDir, 'authentication-session.enc'), { force: true }),
        rm(join(userDataDir, 'authentication-session.enc.pending'), { force: true })
      ])
      launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['en-US'],
        serverUrl: identityServer!.serverUrl
      })
      await expect(launched.page.getByLabel('Email')).toHaveValue(identity.email)
    } finally {
      await launched.electronApp.close().catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)

test(
  'a delayed failed clear after successful login explains persistence on the authenticated surface',
  { tag: '@smoke' },
  async () => {
    test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
    if (!identityServer) return

    const identity = uniqueIdentity('remembered-active-surface-clear-failure')
    await createStableTeamUser(identityServer, identity)
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-clear-failure-'))
    const recordPath = join(userDataDir, rememberedEmailFileName)
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl,
      environment: { NEVIX_TEST_REMEMBERED_EMAIL_CLEAR_DELAY_MS: '3000' }
    })
    const persistenceNotice = launched.page.getByText(
      'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
    )

    try {
      if (!(await hasSecurePersistenceBackend(launched.electronApp))) {
        await launched.electronApp.close()
        test.skip(true, 'requires Keychain, DPAPI, or Secret Service for native persistence')
      }

      await launched.page.evaluate(
        async (email) => window.api.invoke('authentication:replace-remembered-email', { email }),
        identity.email
      )
      await launched.page.reload()
      await expect(launched.page.getByLabel('Email')).toHaveValue(identity.email)
      await rm(recordPath, { force: true })
      await mkdir(recordPath)

      await launched.page.getByRole('checkbox', { name: 'Remember sign-in address' }).uncheck()
      await launched.page.getByLabel('Password').fill(identity.password)
      await launched.page.getByRole('button', { name: 'Sign in' }).click()

      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      await expect(persistenceNotice).toBeVisible({ timeout: 10_000 })
      await expect(persistenceNotice).toHaveCount(1)
    } finally {
      await launched.electronApp.close().catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)

test(
  'a stale failed clear cannot route the next memory-only replacement notice to login',
  { tag: '@smoke' },
  async () => {
    test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
    if (!identityServer) return

    const identity = uniqueIdentity('remembered-stale-clear-failure')
    await createStableTeamUser(identityServer, identity)
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-stale-clear-'))
    const recordPath = join(userDataDir, rememberedEmailFileName)
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl,
      environment: { NEVIX_TEST_REMEMBERED_EMAIL_CLEAR_DELAY_MS: '3000' }
    })
    const persistenceNotice = launched.page.getByText(
      'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
    )

    try {
      if (!(await hasSecurePersistenceBackend(launched.electronApp))) {
        await launched.electronApp.close()
        test.skip(true, 'requires Keychain, DPAPI, or Secret Service for native persistence')
      }

      await launched.page.evaluate(
        async (email) => window.api.invoke('authentication:replace-remembered-email', { email }),
        'previous-stale-clear@example.com'
      )
      await rm(recordPath, { force: true })
      await mkdir(recordPath)

      await launched.page.getByRole('checkbox', { name: 'Remember sign-in address' }).uncheck()
      await launched.page.getByRole('checkbox', { name: 'Remember sign-in address' }).check()
      await launched.page.getByLabel('Email').fill(identity.email)
      await launched.page.getByLabel('Password').fill(identity.password)
      await launched.page.getByRole('button', { name: 'Sign in' }).click()

      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      await expect(persistenceNotice).toBeVisible({ timeout: 10_000 })
      await expect(persistenceNotice).toHaveCount(1)
      await expect
        .poll(
          () =>
            launched.page.evaluate(async () =>
              window.api.invoke('authentication:read-remembered-email')
            ),
          { timeout: 10_000 }
        )
        .toEqual({ outcome: 'email', email: identity.email, persistence: 'memory-only' })
    } finally {
      await launched.electronApp.close().catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)

test('a failed clear keeps the preference selected and explains that secure storage is unavailable', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SERVER_URL,
    'requires the configured build produced by the E2E command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-clear-failure-'))
  const recordPath = join(userDataDir, rememberedEmailFileName)
  let launched = await launchTestApp({
    userDataDir,
    systemLanguages: ['en-US'],
    serverUrl: identityServer!.serverUrl
  })

  try {
    if (!(await hasSecurePersistenceBackend(launched.electronApp))) {
      await launched.electronApp.close()
      test.skip(true, 'requires Keychain, DPAPI, or Secret Service for native persistence')
    }

    await launched.page.evaluate(
      async (email) => window.api.invoke('authentication:replace-remembered-email', { email }),
      'cannot-clear@example.com'
    )
    await launched.electronApp.close()
    launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    await expect(launched.page.getByLabel('Email')).toHaveValue('cannot-clear@example.com')

    await rm(recordPath, { force: true })
    await mkdir(recordPath)
    await launched.page.getByRole('checkbox', { name: 'Remember sign-in address' }).click()

    await expect(
      launched.page.getByRole('checkbox', { name: 'Remember sign-in address' })
    ).toBeChecked()
    await expect(
      launched.page.getByText(
        'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
      )
    ).toBeVisible()
  } finally {
    await launched.electronApp.close().catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test(
  'a login persistence notice clears after the next replacement persists',
  { tag: '@smoke' },
  async () => {
    test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
    if (!identityServer) return

    const identity = uniqueIdentity('remembered-login-notice-recovery')
    await createStableTeamUser(identityServer, identity)
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-login-recovery-'))
    const recordPath = join(userDataDir, rememberedEmailFileName)
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    const persistenceNotice = launched.page.getByText(
      'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
    )

    try {
      if (!(await hasSecurePersistenceBackend(launched.electronApp))) {
        await launched.electronApp.close()
        test.skip(true, 'requires Keychain, DPAPI, or Secret Service for native persistence')
      }

      await launched.page.evaluate(
        async (email) => window.api.invoke('authentication:replace-remembered-email', { email }),
        'previous-login-recovery@example.com'
      )
      await rm(recordPath, { force: true })
      await mkdir(recordPath)
      await launched.page.getByRole('checkbox', { name: 'Remember sign-in address' }).uncheck()

      await expect(
        launched.page.getByRole('checkbox', { name: 'Remember sign-in address' })
      ).toBeChecked()
      await expect(persistenceNotice).toBeVisible()

      await rm(recordPath, { recursive: true, force: true })
      await launched.page.getByLabel('Email').fill(identity.email)
      await launched.page.getByLabel('Password').fill(identity.password)
      await launched.page.getByRole('button', { name: 'Sign in' }).click()

      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      await expect(persistenceNotice).toHaveCount(0)
      await expect
        .poll(() =>
          launched.page.evaluate(async () =>
            window.api.invoke('authentication:read-remembered-email')
          )
        )
        .toEqual({ outcome: 'email', email: identity.email, persistence: 'secure' })
    } finally {
      await launched.electronApp.close().catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)

test('unavailable secure storage keeps Remembered Email only in the current process', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SERVER_URL,
    'requires the configured build produced by the E2E command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-memory-'))
  const memoryEmail = 'memory-only@example.com'
  const recordPath = join(userDataDir, rememberedEmailFileName)
  const unavailableEnvironment = { NEVIX_TEST_UNAVAILABLE_SECURE_STORAGE: '1' }
  let launched = await launchTestApp({
    userDataDir,
    systemLanguages: ['en-US'],
    serverUrl: identityServer!.serverUrl,
    environment: unavailableEnvironment
  })

  try {
    const persistenceNotice = launched.page.getByText(
      'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
    )
    await expect(persistenceNotice).toBeVisible()
    await expect(persistenceNotice).toHaveCount(1)

    const writeResult = await launched.page.evaluate(
      async (email) => window.api.invoke('authentication:replace-remembered-email', { email }),
      memoryEmail
    )
    expect(writeResult).toEqual({ outcome: 'memory-only' })
    await expect.poll(() => fileExists(recordPath)).toBe(false)

    await launched.page.reload()
    await expect(launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible()
    await expect(launched.page.getByLabel('Email')).toHaveValue(memoryEmail)
    await expect(launched.page.getByLabel('Password')).toBeFocused()
    await expect(persistenceNotice).toBeVisible()
    await expect(persistenceNotice).toHaveCount(1)

    await launched.electronApp.close()
    launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl,
      environment: unavailableEnvironment
    })
    await expect(launched.page.getByLabel('Email')).toHaveValue('')
    await expect(launched.page.getByLabel('Email')).toBeFocused()
    await expect.poll(() => fileExists(recordPath)).toBe(false)
  } finally {
    await launched.electronApp.close().catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('an encryption failure keeps the new email in memory without writing plaintext', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SERVER_URL,
    'requires the configured build produced by the E2E command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-encryption-'))
  const email = 'encryption-fallback@example.com'
  const recordPath = join(userDataDir, rememberedEmailFileName)
  const failureEnvironment = { NEVIX_TEST_FAIL_REMEMBERED_EMAIL_ENCRYPTION: '1' }
  let launched = await launchTestApp({
    userDataDir,
    systemLanguages: ['en-US'],
    serverUrl: identityServer!.serverUrl,
    environment: failureEnvironment
  })

  try {
    if (!(await hasSecurePersistenceBackend(launched.electronApp))) {
      await launched.electronApp.close()
      test.skip(true, 'requires a secure backend before encryption can be injected to fail')
    }

    const result = await launched.page.evaluate(
      async (value) =>
        window.api.invoke('authentication:replace-remembered-email', { email: value }),
      email
    )
    expect(result).toEqual({ outcome: 'memory-only' })
    await expect.poll(() => fileExists(recordPath)).toBe(false)

    await launched.page.reload()
    await expect(launched.page.getByLabel('Email')).toHaveValue(email)
    await expect(
      launched.page.getByText(
        'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
      )
    ).toBeVisible()

    await launched.electronApp.close()
    launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl,
      environment: failureEnvironment
    })
    await expect(launched.page.getByLabel('Email')).toHaveValue('')
    await expect.poll(() => fileExists(recordPath)).toBe(false)
  } finally {
    await launched.electronApp.close().catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test(
  'an authenticated persistence notice clears after secure storage recovers',
  { tag: '@smoke' },
  async () => {
    test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
    if (!identityServer) return

    const identity = uniqueIdentity('remembered-authenticated-notice-recovery')
    await createStableTeamUser(identityServer, identity)
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-notice-recovery-'))
    const pendingPath = join(userDataDir, `${rememberedEmailFileName}.pending`)
    await mkdir(pendingPath)
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    const persistenceNotice = launched.page.getByText(
      'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
    )

    try {
      if (!(await hasSecurePersistenceBackend(launched.electronApp))) {
        await launched.electronApp.close()
        test.skip(true, 'requires Keychain, DPAPI, or Secret Service for native persistence')
      }

      await launched.page.getByLabel('Email').fill(identity.email)
      await launched.page.getByLabel('Password').fill(identity.password)
      await launched.page.getByRole('button', { name: 'Sign in' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      await expect(persistenceNotice).toBeVisible()
      await expect(persistenceNotice).toHaveCount(1)

      await signOutFromUserMenu(launched.page)
      await rm(pendingPath, { recursive: true, force: true })
      await launched.page.getByLabel('Password').fill(identity.password)
      await launched.page.getByRole('button', { name: 'Sign in' }).click()

      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      await expect(persistenceNotice).toHaveCount(0)
      await expect
        .poll(() =>
          launched.page.evaluate(async () =>
            window.api.invoke('authentication:read-remembered-email')
          )
        )
        .toEqual({ outcome: 'email', email: identity.email, persistence: 'secure' })
    } finally {
      await launched.electronApp.close().catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)

test('a failed atomic write keeps the previous encrypted record and the new in-process value', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SERVER_URL,
    'requires the configured build produced by the E2E command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-write-'))
  const recordPath = join(userDataDir, rememberedEmailFileName)
  const pendingPath = `${recordPath}.pending`
  const previousEmail = 'previous-write@example.com'
  const replacementEmail = 'replacement-write@example.com'
  let launched = await launchTestApp({
    userDataDir,
    systemLanguages: ['en-US'],
    serverUrl: identityServer!.serverUrl
  })

  try {
    if (!(await hasSecurePersistenceBackend(launched.electronApp))) {
      await launched.electronApp.close()
      test.skip(true, 'requires Keychain, DPAPI, or Secret Service for native persistence')
    }

    await launched.page.evaluate(
      async (email) => window.api.invoke('authentication:replace-remembered-email', { email }),
      previousEmail
    )
    const previousEnvelope = await readFile(recordPath, 'utf8')
    await mkdir(pendingPath)

    const result = await launched.page.evaluate(
      async (email) => window.api.invoke('authentication:replace-remembered-email', { email }),
      replacementEmail
    )
    expect(result).toEqual({ outcome: 'memory-only' })
    expect(await readFile(recordPath, 'utf8')).toBe(previousEnvelope)

    await launched.page.reload()
    await expect(launched.page.getByLabel('Email')).toHaveValue(replacementEmail)
    await expect(
      launched.page.getByText(
        'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
      )
    ).toBeVisible()

    await launched.electronApp.close()
    await rm(pendingPath, { recursive: true, force: true })
    launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    await expect(launched.page.getByLabel('Email')).toHaveValue(previousEmail)
  } finally {
    await launched.electronApp.close().catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('a corrupt Remembered Email record is deleted with a generic internal warning', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SERVER_URL,
    'requires the configured build produced by the E2E command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-corrupt-'))
  const recordPath = join(userDataDir, rememberedEmailFileName)
  const sensitiveMarker = 'must-not-leak@example.com'
  await writeFile(recordPath, JSON.stringify({ version: 99, ciphertext: sensitiveMarker }))

  const launched = await launchTestApp({
    userDataDir,
    systemLanguages: ['en-US'],
    serverUrl: identityServer!.serverUrl
  })
  try {
    await expect(launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible()
    await expect(launched.page.getByLabel('Email')).toHaveValue('')
    await expect(launched.page.getByLabel('Email')).toBeFocused()
    await expect.poll(() => fileExists(recordPath)).toBe(false)

    const diagnosticsPath = test.info().outputPath('electron.log')
    await expect
      .poll(async () => {
        try {
          return await readFile(diagnosticsPath, 'utf8')
        } catch {
          return ''
        }
      })
      .toContain('Remembered Email storage discarded an unreadable encrypted record.')
    const diagnostics = await readFile(diagnosticsPath, 'utf8')
    expect(diagnostics).not.toContain(sensitiveMarker)
    expect(diagnostics).not.toContain(recordPath)
  } finally {
    await launched.electronApp.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test(
  'a non-missing read failure is deleted and treated as unreadable without a user warning',
  { tag: '@smoke' },
  async () => {
    test.skip(
      !process.env.NEVIX_TEST_SERVER_URL,
      'requires the configured build produced by the E2E command'
    )

    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-unreadable-'))
    const recordPath = join(userDataDir, rememberedEmailFileName)
    await mkdir(recordPath)
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })

    try {
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expect(launched.page.getByLabel('Email')).toHaveValue('')
      await expect(launched.page.getByLabel('Email')).toBeFocused()
      await expect.poll(() => pathExists(recordPath)).toBe(false)
      await expect(
        launched.page.getByText(
          'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
        )
      ).toHaveCount(0)

      const diagnosticsPath = test.info().outputPath('electron.log')
      await expect
        .poll(async () => {
          try {
            return await readFile(diagnosticsPath, 'utf8')
          } catch {
            return ''
          }
        })
        .toContain('Remembered Email storage discarded an unreadable encrypted record.')
      const diagnostics = await readFile(diagnosticsPath, 'utf8')
      expect(diagnostics).not.toContain(recordPath)
    } finally {
      await launched.electronApp.close()
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)

test('Linux basic_text keeps Remembered Email in memory without creating a record', async () => {
  test.skip(process.platform !== 'linux', 'Linux safeStorage backend acceptance')
  test.skip(
    !process.env.NEVIX_TEST_SERVER_URL,
    'requires the configured build produced by the E2E command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-basic-text-'))
  const recordPath = join(userDataDir, rememberedEmailFileName)
  const launched = await launchTestApp({
    userDataDir,
    systemLanguages: ['en-US'],
    serverUrl: identityServer!.serverUrl,
    environment: { NEVIX_TEST_FORCE_BASIC_TEXT_STORAGE: '1' }
  })

  try {
    const result = await launched.page.evaluate(async () =>
      window.api.invoke('authentication:replace-remembered-email', {
        email: 'basic-text@example.com'
      })
    )
    expect(result).toEqual({ outcome: 'memory-only' })
    await expect.poll(() => fileExists(recordPath)).toBe(false)
    await expect(
      launched.page.getByText(
        'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
      )
    ).toBeVisible()
  } finally {
    await launched.electronApp.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})
