import { expect, test } from '@playwright/test'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'

const tlsUrl = process.env.NEVIX_TEST_TLS_URL
const tlsRotationDir = process.env.NEVIX_TEST_TLS_DIR
const fingerprintA = process.env.NEVIX_TEST_TLS_FINGERPRINT_A

/**
 * Rotates the TLS terminator onto a named certificate by atomically replacing
 * the rotation pointer the terminator watches.
 */
async function rotateCertificateTo(name: 'a' | 'e'): Promise<void> {
  const pointerPath = join(tlsRotationDir!, 'rotation.json')
  const pendingPath = `${pointerPath}.pending`
  await writeFile(
    pendingPath,
    JSON.stringify({ cert: `cert-${name}.pem`, key: `key-${name}.pem` }),
    'utf8'
  )
  await rename(pendingPath, pointerPath)
  // Let the terminator's directory watcher apply the new secure context before
  // the next handshake.
  await new Promise((resolve) => setTimeout(resolve, 750))
}

test(
  'an expired certificate is a named connection defect and recovers after rotation',
  { tag: '@smoke' },
  async () => {
    test.skip(
      !tlsUrl || !tlsRotationDir || !fingerprintA,
      'requires the TLS terminator stack produced by the E2E command'
    )

    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-connection-expired-'))

    try {
      const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

      try {
        // Establish the trusted baseline on the live certificate first.
        await launched.page.getByLabel('Server address').fill(tlsUrl!)
        await launched.page.getByRole('button', { name: 'Test connection' }).click()
        const decision = launched.page.getByTestId('certificate-decision')
        await expect(decision).toBeVisible({ timeout: 20_000 })
        await decision.getByRole('button', { name: 'Trust this fingerprint' }).click()
        await expect(launched.page.getByTestId('connection-probe-reachable')).toBeVisible({
          timeout: 20_000
        })

        // The server now presents the expired certificate: the probe names the
        // defect instead of a generic connection failure, and never offers a
        // trust question for an expired chain.
        await rotateCertificateTo('e')
        await launched.page.getByRole('button', { name: 'Test connection' }).click()
        await expect(launched.page.getByText(/The server certificate expired on/)).toBeVisible({
          timeout: 20_000
        })
        await expect(launched.page.getByTestId('certificate-decision')).toHaveCount(0)
        await expect(
          launched.page.getByRole('button', { name: 'Save and continue' })
        ).toBeDisabled()

        // Recovery: the operator rotates the certificate; the remembered pin
        // restores the connection without any new question.
        await rotateCertificateTo('a')
        await launched.page.getByRole('button', { name: 'Test connection' }).click()
        await expect(launched.page.getByTestId('connection-probe-reachable')).toBeVisible({
          timeout: 20_000
        })
        await expect(launched.page.getByTestId('certificate-decision')).toHaveCount(0)
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
)
