import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import https from 'node:https'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'

const tlsRotationDir = process.env.NEVIX_TEST_TLS_DIR

test('a pinned foreign HTTPS service is never reported as a reachable Nevix server', async () => {
  test.skip(!tlsRotationDir, 'requires the TLS terminator stack produced by the E2E command')

  // A spec-local HTTPS server presenting the harness's self-signed
  // certificate but answering with a non-Nevix body: pinning its fingerprint
  // must still not make it reachable (#153 — the TOFU path checks the Nevix
  // /health identity too).
  const [cert, key] = await Promise.all([
    readFile(join(tlsRotationDir!, 'cert-a.pem'), 'utf8'),
    readFile(join(tlsRotationDir!, 'key-a.pem'), 'utf8')
  ])
  const foreignServer = https.createServer({ cert, key }, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    // Exercise the pinned body's bounded reader as well as the identity check:
    // overflow must settle as incompatible without crashing Electron main.
    response.end('x'.repeat(64 * 1024 + 1))
  })
  await new Promise<void>((resolve) => foreignServer.listen(0, '127.0.0.1', resolve))
  const foreignUrl = `https://127.0.0.1:${(foreignServer.address() as AddressInfo).port}`

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-connection-foreign-'))

  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })

    try {
      await launched.page.getByLabel('Server address').fill(foreignUrl)
      await launched.page.getByRole('button', { name: 'Test connection' }).click()

      // First use asks for the fingerprint decision as usual.
      const decision = launched.page.getByTestId('certificate-decision')
      await expect(decision).toBeVisible({ timeout: 20_000 })
      await decision.getByRole('button', { name: 'Trust this fingerprint' }).click()

      // The pin now accepts the chain, but the /health identity does not: the
      // verdict is incompatible-server, and saving stays blocked.
      await expect(
        launched.page.getByText('The server is reachable but is not a Nevix server')
      ).toBeVisible({ timeout: 20_000 })
      await expect(launched.page.getByTestId('connection-probe-reachable')).toHaveCount(0)
      await expect(launched.page.getByRole('button', { name: 'Save and continue' })).toBeDisabled()
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
    await new Promise<void>((resolve) => foreignServer.close(() => resolve()))
  }
})
