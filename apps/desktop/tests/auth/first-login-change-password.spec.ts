import { expect, test, type Page } from '@playwright/test'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hasSecurePersistenceBackend,
  launchTestApp,
  signOutFromUserMenu
} from '../helpers/electron-app'
import {
  createTeamUser,
  loginOutsideDesktop,
  readIdentityServerConfig,
  uniqueIdentity
} from './helpers/identity-server'

const identityServer = readIdentityServerConfig()
const identityServerFailureMarkerDir = process.env.NEVIX_TEST_IDENTITY_SERVER_FAILURE_MARKER_DIR

const REPLACEMENT_PASSWORD = 'replacement horse battery staple'

async function injectIdentityServerFailureAfterRendererLaunch(): Promise<void> {
  if (!identityServerFailureMarkerDir) return

  await writeFile(
    join(identityServerFailureMarkerDir, 'request-ready'),
    `${new Date().toISOString()}\n`
  )
  await expect
    .poll(() =>
      access(join(identityServerFailureMarkerDir, 'server-stopped')).then(
        () => true,
        () => false
      )
    )
    .toBe(true)
}

/** The full closed loop this migration ships: login → forced change → App Shell → sign out. */
test(
  'a first login forces the initial password change before the App Shell opens',
  { tag: '@smoke' },
  async () => {
    test.setTimeout(120_000)
    test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
    if (!identityServer) return

    const identity = uniqueIdentity('first-login-change')
    await createTeamUser(identityServer, identity, 'First Login Change')
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-first-login-'))

    try {
      const launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['en-US'],
        serverUrl: identityServer!.serverUrl
      })
      try {
        await signIn(launched.page, identity)

        // The forced change boundary replaces the App Shell until the change completes.
        await expect(
          launched.page.getByRole('heading', { name: 'Set a new password' })
        ).toBeVisible()
        await expect(
          launched.page.getByText(
            'Your administrator set an initial password. Set your own new password before continuing.'
          )
        ).toBeVisible()
        await expect(
          launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
        ).toHaveCount(0)

        // A wrong initial password keeps the boundary with its specific error.
        await launched.page
          .getByLabel('Initial password', { exact: true })
          .fill(`${identity.password}-wrong`)
        await launched.page.getByLabel('New password', { exact: true }).fill(REPLACEMENT_PASSWORD)
        await launched.page.getByLabel('Confirm new password').fill(REPLACEMENT_PASSWORD)
        await launched.page.getByRole('button', { name: 'Update password and continue' }).click()
        await expect(
          launched.page.getByRole('alert').filter({ hasText: 'The initial password is incorrect' })
        ).toBeVisible()

        // Controlled failure-injection mode: the harness kills the server after the renderer
        // launched; the change submission must surface the explicit unreachable-server state.
        if (identityServerFailureMarkerDir) {
          await injectIdentityServerFailureAfterRendererLaunch()
          await launched.page
            .getByLabel('Initial password', { exact: true })
            .fill(identity.password)
          await launched.page.getByRole('button', { name: 'Update password and continue' }).click()
          await expect(
            launched.page.getByRole('alert').filter({
              hasText: 'The password cannot be updated right now. Try again later.'
            })
          ).toBeVisible({ timeout: 30_000 })
          await expect(
            launched.page.getByRole('heading', { name: 'Set a new password' })
          ).toBeVisible()
          return
        }

        // The correct initial password completes the change and opens the App Shell.
        await launched.page.getByLabel('Initial password', { exact: true }).fill(identity.password)
        await launched.page.getByLabel('New password', { exact: true }).fill(REPLACEMENT_PASSWORD)
        await launched.page.getByLabel('Confirm new password').fill(REPLACEMENT_PASSWORD)
        await launched.page.getByRole('button', { name: 'Update password and continue' }).click()
        await expect(
          launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
        ).toBeVisible()
        await expect(
          launched.page.getByRole('heading', { name: 'Set a new password' })
        ).toHaveCount(0)

        // Sign out ends the session on this device only.
        await signOutFromUserMenu(launched.page)
        await expect(
          launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
        ).toBeVisible()
      } finally {
        await launched.electronApp.close()
      }

      // The replacement password signs in straight to the App Shell — no second forced change.
      const relaunched = await launchTestApp({
        userDataDir,
        systemLanguages: ['en-US'],
        serverUrl: identityServer!.serverUrl
      })
      try {
        await signIn(relaunched.page, { email: identity.email, password: REPLACEMENT_PASSWORD })
        await expect(
          relaunched.page.getByRole('heading', { name: 'Create with Nevix AI' })
        ).toBeVisible()
        await expect(
          relaunched.page.getByRole('heading', { name: 'Set a new password' })
        ).toHaveCount(0)
      } finally {
        await relaunched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)

test('a mismatched confirmation and a short new password never reach the server', async () => {
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const identity = uniqueIdentity('first-login-validation')
  await createTeamUser(identityServer, identity)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-first-login-validation-'))

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      await signIn(launched.page, identity)
      await expect(launched.page.getByRole('heading', { name: 'Set a new password' })).toBeVisible()

      let changeRequests = 0
      await launched.page.route('**/identity/auth/change-password', (route) => {
        changeRequests += 1
        return route.continue()
      })

      // A short new password shows the policy feedback and blocks submission.
      await launched.page.getByLabel('Initial password', { exact: true }).fill(identity.password)
      await launched.page.getByLabel('New password', { exact: true }).fill('short')
      await launched.page.getByLabel('Confirm new password').fill('short')
      await expect(
        launched.page.getByRole('button', { name: 'Update password and continue' })
      ).toBeDisabled()
      await expect(launched.page.getByText('Password is too short.')).toBeVisible()

      // A mismatched confirmation blocks submission as well.
      await launched.page.getByLabel('New password', { exact: true }).fill(REPLACEMENT_PASSWORD)
      await launched.page
        .getByLabel('Confirm new password')
        .fill(`${REPLACEMENT_PASSWORD}-mismatch`)
      await expect(
        launched.page.getByRole('button', { name: 'Update password and continue' })
      ).toBeDisabled()
      await expect(launched.page.getByText('Passwords do not match')).toBeVisible()
      expect(changeRequests).toBe(0)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('signing out from the forced change boundary keeps the account pending, and the initial password still works', async () => {
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const identity = uniqueIdentity('first-login-escape')
  await createTeamUser(identityServer, identity)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-first-login-escape-'))

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      await signIn(launched.page, identity)
      await expect(launched.page.getByRole('heading', { name: 'Set a new password' })).toBeVisible()

      await launched.page.getByRole('button', { name: 'Sign out without changing' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
    } finally {
      await launched.electronApp.close()
    }

    // The initial password is untouched by the escape, so the next session forces the change again.
    const grant = await loginOutsideDesktop(identityServer, identity)
    expect(grant.user.must_change_password).toBe(true)
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('a stored session that still owes the change returns to the forced change boundary after relaunch', async () => {
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const identity = uniqueIdentity('first-login-restore')
  await createTeamUser(identityServer, identity)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-first-login-restore-'))

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      // Relaunching a stored gated session requires a backend that actually persists the
      // envelope; CI-forced basic_text stores nothing by design.
      test.skip(
        !(await hasSecurePersistenceBackend(launched.electronApp)),
        'requires a native Keychain, DPAPI, or Secret Service backend'
      )
      await signIn(launched.page, identity)
      await expect(launched.page.getByRole('heading', { name: 'Set a new password' })).toBeVisible()
      // Closing the app mid-flow leaves the session persisted but still gated.
    } finally {
      await launched.electronApp.close()
    }

    const relaunched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: identityServer!.serverUrl
    })
    try {
      await expect(
        relaunched.page.getByRole('heading', { name: 'Set a new password' })
      ).toBeVisible()
      await expect(
        relaunched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toHaveCount(0)
    } finally {
      await relaunched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

async function signIn(
  page: Page,
  identity: { readonly email: string; readonly password: string }
): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible()
  await page.getByLabel('Email').fill(identity.email)
  await page.getByLabel('Password').fill(identity.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}
