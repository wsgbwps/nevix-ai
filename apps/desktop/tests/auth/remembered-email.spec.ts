import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hasSecurePersistenceBackend,
  launchTestApp,
  signOutFromUserMenu
} from '../helpers/electron-app'
import {
  createAuthUser,
  deleteAuthUser,
  readAuthHarnessConfig,
  uniqueAuthIdentity
} from './helpers/supabase-auth'
import { seedOrganizationWithMembership } from '../organization/helpers/organization-seed'

const authHarness = readAuthHarnessConfig()
const rememberedEmailFileName = 'authentication-remembered-email.enc'

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

test(
  'an empty Remembered Email defaults selected and focuses the email field',
  { tag: '@smoke' },
  async () => {
    test.skip(
      !process.env.NEVIX_TEST_SUPABASE_URL,
      'requires the configured build produced by the Auth test command'
    )

    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-empty-'))

    try {
      const launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['en-US']
      })

      try {
        await expect(
          launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
        ).toBeVisible()
        await expect(
          launched.page.getByRole('checkbox', { name: 'Remember sign-in address' })
        ).toBeChecked()
        await expect(launched.page.getByLabel('Email')).toHaveValue('')
        await expect(launched.page.getByLabel('Email')).toBeFocused()
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)

test('a successful password login securely remembers the authoritative email independently of the Session', async () => {
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('remembered-success')
  const userId = await createAuthUser(authHarness, identity, true)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-success-'))
  let launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

  try {
    if (!(await hasSecurePersistenceBackend(launched.electronApp))) {
      await launched.electronApp.close()
      test.skip(true, 'requires Keychain, DPAPI, or Secret Service for native persistence')
    }

    const submittedEmail = identity.email
    await launched.page.evaluate(
      async (email) => window.api.invoke('authentication:replace-remembered-email', { email }),
      'previous-user@example.com'
    )
    await launched.page.getByLabel('Email').fill(submittedEmail)
    await launched.page.getByLabel('Password').fill(identity.password)
    await launched.page.getByRole('button', { name: 'Sign in' }).click()

    await expect
      .poll(async () => {
        try {
          await readFile(join(userDataDir, rememberedEmailFileName), 'utf8')
          return true
        } catch {
          return false
        }
      })
      .toBe(true)
    const persistedEnvelope = await readFile(join(userDataDir, rememberedEmailFileName), 'utf8')
    expect(persistedEnvelope).not.toContain(identity.email)
    expect(persistedEnvelope).not.toContain(submittedEmail)
    expect(persistedEnvelope).not.toContain(identity.password)
    expect(persistedEnvelope).not.toContain('access_token')
    expect(persistedEnvelope).not.toContain('refresh_token')

    await launched.electronApp.close()
    await Promise.all([
      rm(join(userDataDir, 'authentication-session.enc'), { force: true }),
      rm(join(userDataDir, 'authentication-session.enc.pending'), { force: true })
    ])
    launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    await expect(launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible()
    await expect(launched.page.getByLabel('Email')).toHaveValue(identity.email)
    await expect(launched.page.getByLabel('Password')).toBeFocused()
    await expect(
      launched.page.getByRole('checkbox', { name: 'Remember sign-in address' })
    ).toBeChecked()
  } finally {
    await launched.electronApp.close().catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, userId)
  }
})

test('a failed password login keeps typed input without replacing the saved email', async () => {
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const savedEmail = 'previously-verified@example.com'
  const failedIdentity = uniqueAuthIdentity('remembered-failed')
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-failed-'))
  let launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

  try {
    if (!(await hasSecurePersistenceBackend(launched.electronApp))) {
      await launched.electronApp.close()
      test.skip(true, 'requires Keychain, DPAPI, or Secret Service for native persistence')
    }

    await launched.page.evaluate(
      async (email) => window.api.invoke('authentication:replace-remembered-email', { email }),
      savedEmail
    )
    await launched.electronApp.close()
    launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

    await launched.page.getByLabel('Email').fill(failedIdentity.email)
    await launched.page.getByLabel('Password').fill(failedIdentity.password)
    await launched.page.getByRole('button', { name: 'Sign in' }).click()
    await expect(
      launched.page.getByRole('alert').filter({ hasText: 'Email or password is incorrect' })
    ).toBeVisible()
    await expect(launched.page.getByLabel('Email')).toHaveValue(failedIdentity.email)

    await launched.electronApp.close()
    launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    await expect(launched.page.getByLabel('Email')).toHaveValue(savedEmail)
    await expect(launched.page.getByLabel('Password')).toBeFocused()
  } finally {
    await launched.electronApp.close().catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('clearing Remembered Email is immediate and reselecting does not save unverified input', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SUPABASE_URL,
    'requires the configured build produced by the Auth test command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-clear-'))
  const seededEmail = 'remembered@example.com'
  const unverifiedEmail = 'not-verified@example.com'
  const recordPath = join(userDataDir, rememberedEmailFileName)
  let launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

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
    launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    await expect(launched.page.getByLabel('Email')).toHaveValue(seededEmail)

    await launched.page.getByRole('checkbox', { name: 'Remember sign-in address' }).uncheck()
    await expect.poll(() => fileExists(recordPath)).toBe(false)
    await expect(launched.page.getByLabel('Email')).toHaveValue(seededEmail)

    await launched.page.getByRole('checkbox', { name: 'Remember sign-in address' }).check()
    await launched.page.getByLabel('Email').fill(unverifiedEmail)
    await launched.electronApp.close()
    launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

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

test('a failed clear keeps the preference selected and explains that secure storage is unavailable', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SUPABASE_URL,
    'requires the configured build produced by the Auth test command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-clear-failure-'))
  const recordPath = join(userDataDir, rememberedEmailFileName)
  let launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

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
    launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
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

test('a new login boundary restores the selected default when no Remembered Email exists', async () => {
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('remembered-default-reset')
  const userId = await createAuthUser(authHarness, identity, true)
  await seedOrganizationWithMembership(userId, { name: 'Remembered Default Reset Org' })
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-default-reset-'))
  const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

  try {
    await launched.page.getByRole('checkbox', { name: 'Remember sign-in address' }).uncheck()
    await launched.page.getByLabel('Email').fill(identity.email)
    await launched.page.getByLabel('Password').fill(identity.password)
    await launched.page.getByRole('button', { name: 'Sign in' }).click()
    await expect(launched.page.getByRole('heading', { name: 'Create with Nevix AI' })).toBeVisible()

    await signOutFromUserMenu(launched.page)
    await expect(launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible()
    await expect(launched.page.getByLabel('Email')).toHaveValue('')
    await expect(
      launched.page.getByRole('checkbox', { name: 'Remember sign-in address' })
    ).toBeChecked()
  } finally {
    await launched.electronApp.close()
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, userId)
  }
})

test('unavailable secure storage keeps Remembered Email only in the current process', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SUPABASE_URL,
    'requires the configured build produced by the Auth test command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-memory-'))
  const memoryEmail = 'memory-only@example.com'
  const recordPath = join(userDataDir, rememberedEmailFileName)
  const unavailableEnvironment = { NEVIX_TEST_UNAVAILABLE_SECURE_STORAGE: '1' }
  let launched = await launchTestApp({
    userDataDir,
    systemLanguages: ['en-US'],
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
    !process.env.NEVIX_TEST_SUPABASE_URL,
    'requires the configured build produced by the Auth test command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-encryption-'))
  const email = 'encryption-fallback@example.com'
  const recordPath = join(userDataDir, rememberedEmailFileName)
  const failureEnvironment = { NEVIX_TEST_FAIL_REMEMBERED_EMAIL_ENCRYPTION: '1' }
  let launched = await launchTestApp({
    userDataDir,
    systemLanguages: ['en-US'],
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
      environment: failureEnvironment
    })
    await expect(launched.page.getByLabel('Email')).toHaveValue('')
    await expect.poll(() => fileExists(recordPath)).toBe(false)
  } finally {
    await launched.electronApp.close().catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('a successful login shows its memory-only notice on the onboarding surface', async () => {
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('remembered-onboarding-notice')
  const userId = await createAuthUser(authHarness, identity, true)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-onboarding-notice-'))
  const launched = await launchTestApp({
    userDataDir,
    systemLanguages: ['en-US'],
    environment: { NEVIX_TEST_FAIL_REMEMBERED_EMAIL_ENCRYPTION: '1' }
  })

  try {
    if (!(await hasSecurePersistenceBackend(launched.electronApp))) {
      await launched.electronApp.close()
      test.skip(true, 'requires a secure backend before encryption can be injected to fail')
    }

    await launched.page.getByLabel('Email').fill(identity.email)
    await launched.page.getByLabel('Password').fill(identity.password)
    await launched.page.getByRole('button', { name: 'Sign in' }).click()

    await expect(
      launched.page.getByRole('heading', { name: 'What should we call you?' })
    ).toBeVisible()
    await expect(
      launched.page.getByText(
        'This device cannot store a remembered email securely. The current choice lasts only until you close the application.'
      )
    ).toBeVisible()
  } finally {
    await launched.electronApp.close().catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true })
    await deleteAuthUser(authHarness, userId)
  }
})

test('a failed atomic write keeps the previous encrypted record and the new in-process value', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SUPABASE_URL,
    'requires the configured build produced by the Auth test command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-write-'))
  const recordPath = join(userDataDir, rememberedEmailFileName)
  const pendingPath = `${recordPath}.pending`
  const previousEmail = 'previous-write@example.com'
  const replacementEmail = 'replacement-write@example.com'
  let launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

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
    launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    await expect(launched.page.getByLabel('Email')).toHaveValue(previousEmail)
  } finally {
    await launched.electronApp.close().catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('a corrupt Remembered Email record is deleted with a generic internal warning', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SUPABASE_URL,
    'requires the configured build produced by the Auth test command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-corrupt-'))
  const recordPath = join(userDataDir, rememberedEmailFileName)
  const sensitiveMarker = 'must-not-leak@example.com'
  await writeFile(recordPath, JSON.stringify({ version: 99, ciphertext: sensitiveMarker }))

  const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
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
      .toContain('Remembered Email storage discarded an invalid encrypted record.')
    const diagnostics = await readFile(diagnosticsPath, 'utf8')
    expect(diagnostics).not.toContain(sensitiveMarker)
    expect(diagnostics).not.toContain(recordPath)
  } finally {
    await launched.electronApp.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('Linux basic_text keeps Remembered Email in memory without creating a record', async () => {
  test.skip(process.platform !== 'linux', 'Linux safeStorage backend acceptance')
  test.skip(
    !process.env.NEVIX_TEST_SUPABASE_URL,
    'requires the configured build produced by the Auth test command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-remembered-email-basic-text-'))
  const recordPath = join(userDataDir, rememberedEmailFileName)
  const launched = await launchTestApp({
    userDataDir,
    systemLanguages: ['en-US'],
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
