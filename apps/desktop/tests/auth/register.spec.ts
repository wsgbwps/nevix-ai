import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'
import {
  createJoinCode,
  readIdentityServerConfig,
  revokeJoinCode,
  revokeJoinCodeForCleanup,
  uniqueIdentity
} from './helpers/identity-server'

const identityServer = readIdentityServerConfig()

test('a join-code holder registers from the login screen and enters the app', async () => {
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const code = await createJoinCode(identityServer, 'e2e-registration')
  // From the moment the code exists, every exit path revokes it: the suite
  // shares one identity server, and a leaked active code would fail later
  // specs' empty-list assertions — including across a retried run.
  try {
    const identity = uniqueIdentity('self-registered')
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-register-'))

    try {
      const launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['en-US'],
        serverUrl: identityServer!.serverUrl
      })

      try {
        // The registration entry is always visible on the login boundary —
        // whether registration is open is revealed only on submission.
        const registerEntry = launched.page.getByRole('button', {
          name: 'Register with a join code'
        })
        await expect(registerEntry).toBeVisible()

        await registerEntry.click()
        await expect(
          launched.page.getByRole('heading', { name: 'Register with Nevix AI' })
        ).toBeVisible()

        await launched.page.getByLabel('Email').fill(identity.email)
        await launched.page.getByLabel('Password').fill(identity.password)
        await launched.page.getByLabel('Join code').fill(code.code)
        await launched.page.getByLabel('Display name (optional)').fill('Self Registered')
        await launched.page.getByRole('button', { name: 'Register', exact: true }).click()

        // The register response carries a working session: the shell opens
        // directly, with no forced first-login password change in between.
        await expect(
          launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
        ).toBeVisible()
        await expect(
          launched.page.getByRole('heading', { name: 'Set a new password' })
        ).toHaveCount(0)
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  } finally {
    await revokeJoinCodeForCleanup(identityServer, code.id)
  }
})

test('a revoked join code keeps the register form on the boundary with its error copy', async () => {
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const code = await createJoinCode(identityServer)
  try {
    // With the code revoked, no active code remains: registration is closed,
    // and the submission surfaces the unified invalid-join-code answer.
    await revokeJoinCode(identityServer, code.id)

    const identity = uniqueIdentity('closed-registration')
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-auth-register-closed-'))

    try {
      const launched = await launchTestApp({
        userDataDir,
        systemLanguages: ['en-US'],
        serverUrl: identityServer!.serverUrl
      })

      try {
        await launched.page.getByRole('button', { name: 'Register with a join code' }).click()
        await launched.page.getByLabel('Email').fill(identity.email)
        await launched.page.getByLabel('Password').fill(identity.password)
        await launched.page.getByLabel('Join code').fill(code.code)
        await launched.page.getByRole('button', { name: 'Register', exact: true }).click()

        await expect(
          launched.page
            .getByRole('alert')
            .filter({ hasText: 'The join code is not valid. Contact your administrator.' })
        ).toBeVisible()
        await expect(
          launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
        ).toHaveCount(0)

        // The boundary still offers the way back to sign-in.
        await launched.page.getByRole('button', { name: 'Back to sign in' }).click()
        await expect(
          launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
        ).toBeVisible()
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  } finally {
    // Idempotent for the scenario's own revocation above (404 tolerated) and
    // a real cleanup guard on every other exit path.
    await revokeJoinCodeForCleanup(identityServer, code.id)
  }
})
