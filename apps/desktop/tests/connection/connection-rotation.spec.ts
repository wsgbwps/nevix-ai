import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'
import { rotateCertificateTo } from './helpers/tls-rotation'

const tlsUrl = process.env.NEVIX_TEST_TLS_URL
const tlsRotationDir = process.env.NEVIX_TEST_TLS_DIR
const caCertPath = process.env.NEVIX_TEST_TLS_CA_CERT

test('rotating a pinned self-signed deployment to a CA-valid certificate still demands reconfirmation', async () => {
  test.skip(
    !tlsUrl || !tlsRotationDir || !caCertPath,
    'requires the TLS terminator stack produced by the E2E command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-connection-rotation-'))

  try {
    // The throwaway E2E CA is trusted by the main process, so certificate C
    // passes standard verification: this is the rotation a pin must still
    // catch (#153 AC4), not just a second untrusted chain.
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      environment: { NODE_EXTRA_CA_CERTS: caCertPath! }
    })

    try {
      await launched.page.getByLabel('Server address').fill(tlsUrl!)
      await launched.page.getByRole('button', { name: 'Test connection' }).click()

      // First use on the self-signed certificate: confirm by fingerprint.
      const decision = launched.page.getByTestId('certificate-decision')
      await expect(decision).toBeVisible({ timeout: 20_000 })
      await decision.getByRole('button', { name: 'Trust this fingerprint' }).click()
      await expect(launched.page.getByTestId('connection-probe-reachable')).toBeVisible({
        timeout: 20_000
      })

      // Rotation to the CA-valid certificate: standard verification would
      // pass on its own, but the pin changed — a warning, never a silent
      // pass.
      await rotateCertificateTo(tlsRotationDir!, 'c')
      await launched.page.getByRole('button', { name: 'Test connection' }).click()
      const changed = launched.page.getByTestId('certificate-decision')
      await expect(changed).toBeVisible({ timeout: 20_000 })
      await expect(changed.getByText('Server certificate fingerprint changed')).toBeVisible()
      await expect(launched.page.getByTestId('connection-probe-reachable')).toHaveCount(0)

      // Confirming the new fingerprint restores reachability over the
      // CA-valid certificate with the pin matching.
      await changed.getByRole('button', { name: 'Trust this fingerprint' }).click()
      await expect(launched.page.getByTestId('connection-probe-reachable')).toBeVisible({
        timeout: 20_000
      })
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    // The TLS terminator is shared by the serial suite; leave the canonical
    // certificate active so later specs observe their declared baseline.
    await rotateCertificateTo(tlsRotationDir!, 'a')
    await rm(userDataDir, { recursive: true, force: true })
  }
})
