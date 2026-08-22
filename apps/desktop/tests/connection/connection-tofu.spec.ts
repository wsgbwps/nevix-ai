import { expect, test } from '@playwright/test'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp, openSettingsSectionFromUserMenu } from '../helpers/electron-app'
import {
  createStableTeamUser,
  readIdentityServerConfig,
  uniqueIdentity
} from '../auth/helpers/identity-server'

const tlsUrl = process.env.NEVIX_TEST_TLS_URL
const tlsRotationDir = process.env.NEVIX_TEST_TLS_DIR
const fingerprintA = process.env.NEVIX_TEST_TLS_FINGERPRINT_A
const fingerprintB = process.env.NEVIX_TEST_TLS_FINGERPRINT_B

/**
 * Rotates the TLS terminator onto certificate B by atomically replacing the
 * rotation pointer the terminator watches.
 */
async function rotateCertificateToB(): Promise<void> {
  const pointerPath = join(tlsRotationDir!, 'rotation.json')
  const pendingPath = `${pointerPath}.pending`
  await writeFile(pendingPath, JSON.stringify({ cert: 'cert-b.pem', key: 'key-b.pem' }), 'utf8')
  await rename(pendingPath, pointerPath)
  // Let the terminator's directory watcher apply the new secure context before
  // the next handshake.
  await new Promise((resolve) => setTimeout(resolve, 750))
}

test(
  'a self-signed server asks for first-use fingerprint confirmation, is remembered, and a changed fingerprint warns',
  { tag: '@smoke' },
  async () => {
    test.skip(
      !tlsUrl || !tlsRotationDir || !fingerprintA || !fingerprintB,
      'requires the TLS terminator stack produced by the E2E command'
    )
    const identityServer = readIdentityServerConfig()
    test.skip(!identityServer, 'requires the identity server stack produced by the E2E command')

    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-connection-tofu-'))

    try {
      // --- First use: the untrusted certificate must be confirmed by fingerprint.
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

      try {
        await launched.page.getByLabel('Server address').fill(tlsUrl!)
        await launched.page.getByRole('button', { name: 'Test connection' }).click()

        const decision = launched.page.getByTestId('certificate-decision')
        await expect(decision).toBeVisible({ timeout: 20_000 })
        await expect(decision.getByText('Server certificate is not trusted')).toBeVisible()
        await expect(decision.getByText(fingerprintA!, { exact: true })).toBeVisible()
        await expect(
          launched.page.getByRole('button', { name: 'Save and continue' })
        ).toBeDisabled()

        await decision.getByRole('button', { name: 'Trust this fingerprint' }).click()
        await expect(launched.page.getByTestId('connection-probe-reachable')).toBeVisible({
          timeout: 20_000
        })
        await launched.page
          .getByRole('button', { name: 'Save and continue' })
          .click({ noWaitAfter: true })

        // --- The saved URL boots into login; a real sign-in proves the renderer
        // fetches ride the pinned TLS channel.
        await expect(
          launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
        ).toBeVisible({ timeout: 20_000 })

        const identity = uniqueIdentity('tofu')
        await createStableTeamUser(identityServer!, identity)
        await launched.page.getByLabel('Email').fill(identity.email)
        await launched.page.getByLabel('Password').fill(identity.password)
        await launched.page.getByRole('button', { name: 'Sign in', exact: true }).click()
        await expect(
          launched.page.getByRole('button', { name: /user menu|用户菜单/i })
        ).toBeVisible({ timeout: 20_000 })

        // --- The confirmed fingerprint persists and stays in force: a changed
        // certificate surfaces as an explicit warning in Settings.
        await openSettingsSectionFromUserMenu(launched.page, 'Server connection')
        await expect(
          launched.page.getByRole('heading', { name: 'Server connection' })
        ).toBeVisible()
        await expect(launched.page.getByText(tlsUrl!)).toBeVisible()

        await rotateCertificateToB()
        await launched.page.getByRole('button', { name: 'Test connection' }).click()

        const changed = launched.page.getByTestId('certificate-decision')
        await expect(changed).toBeVisible({ timeout: 20_000 })
        await expect(changed.getByText('Server certificate fingerprint changed')).toBeVisible()
        await expect(changed.getByText(fingerprintB!, { exact: true })).toBeVisible()
        await expect(changed.getByText(fingerprintA!, { exact: true })).toHaveCount(0)

        // Trusting the verified new fingerprint restores the connection without
        // any global verification skip.
        await changed.getByRole('button', { name: 'Trust this fingerprint' }).click()
        await expect(launched.page.getByTestId('connection-probe-reachable')).toBeVisible({
          timeout: 20_000
        })
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)

test('a pinned certificate survives relaunch without asking again', async () => {
  test.skip(
    !tlsUrl || !tlsRotationDir || !fingerprintA,
    'requires the TLS terminator stack produced by the E2E command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-connection-pin-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

    try {
      await launched.page.getByLabel('Server address').fill(tlsUrl!)
      await launched.page.getByRole('button', { name: 'Test connection' }).click()
      const decision = launched.page.getByTestId('certificate-decision')
      await expect(decision).toBeVisible({ timeout: 20_000 })
      await decision.getByRole('button', { name: 'Trust this fingerprint' }).click()
      await expect(launched.page.getByTestId('connection-probe-reachable')).toBeVisible({
        timeout: 20_000
      })
      await launched.page
        .getByRole('button', { name: 'Save and continue' })
        .click({ noWaitAfter: true })
      await expect(launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })).toBeVisible(
        { timeout: 20_000 }
      )
    } finally {
      await launched.electronApp.close()
    }

    const relaunched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

    try {
      // Still configured, still trusted: the login boundary appears with no
      // certificate question in between.
      await expect(
        relaunched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible({ timeout: 20_000 })
      await expect(relaunched.page.getByTestId('certificate-decision')).toHaveCount(0)
    } finally {
      await relaunched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})
