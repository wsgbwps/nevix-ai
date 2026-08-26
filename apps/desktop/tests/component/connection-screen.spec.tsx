import { expect, test, type Locator, type Page } from '@playwright/experimental-ct-react'
import { ConnectionScreenStory } from './fixtures/connection-screen-story'

const FINGERPRINT = `ab`.repeat(32)
const CERTIFICATE_VIEW = {
  fingerprint: FINGERPRINT,
  subjectName: 'localhost',
  issuerName: 'localhost',
  validTo: 'Jan 1 00:00:00 2031 GMT'
}

function enqueue(page: Page, channel: string, result: unknown): Promise<void> {
  return page.evaluate(
    ({ c, r }) => {
      window.__connectionTest?.enqueue(c, r)
    },
    { c: channel, r: result }
  )
}

function invokeCalls(page: Page): Promise<readonly { channel: string; request: unknown }[]> {
  return page.evaluate(() => window.__connectionTest?.calls ?? [])
}

async function fillAddressAndTest(component: Locator, address: string): Promise<void> {
  await component.getByLabel('Server address').fill(address)
  await component.getByRole('button', { name: 'Test connection' }).click()
}

test('a standard-verified server is reachable with no certificate question', async ({
  mount,
  page
}) => {
  const component = await mount(<ConnectionScreenStory />)
  await enqueue(page, 'connection:test-server', { outcome: 'reachable' })

  await fillAddressAndTest(component, 'https://deploy.example.com')

  await expect(component.getByTestId('connection-probe-reachable')).toBeVisible()
  await expect(component.getByTestId('certificate-decision')).toHaveCount(0)
  await expect(component.getByTestId('certificate-near-expiry')).toHaveCount(0)
  await expect(component.getByRole('button', { name: 'Save and continue' })).toBeEnabled()
})

test('a self-signed server asks for first-use fingerprint confirmation and blocks saving', async ({
  mount,
  page
}) => {
  const component = await mount(<ConnectionScreenStory />)
  await enqueue(page, 'connection:test-server', {
    outcome: 'certificate-confirmation-required',
    ...CERTIFICATE_VIEW
  })

  await fillAddressAndTest(component, 'https://deploy.example.com')

  const decision = component.getByTestId('certificate-decision')
  await expect(decision).toBeVisible()
  await expect(decision.getByText('Server certificate is not trusted')).toBeVisible()
  await expect(decision.getByText(/AB:AB/)).toBeVisible()
  await expect(component.getByRole('button', { name: 'Save and continue' })).toBeDisabled()
})

test('refusing the fingerprint confirmation never trusts or saves the connection', async ({
  mount,
  page
}) => {
  const component = await mount(<ConnectionScreenStory />)
  await enqueue(page, 'connection:test-server', {
    outcome: 'certificate-confirmation-required',
    ...CERTIFICATE_VIEW
  })

  await fillAddressAndTest(component, 'https://deploy.example.com')
  await expect(component.getByTestId('certificate-decision')).toBeVisible()

  // The user refuses: they walk away from the decision by editing the address.
  await component.getByLabel('Server address').fill('https://other.example.com')

  await expect(component.getByTestId('certificate-decision')).toHaveCount(0)
  const channels = (await invokeCalls(page)).map((call) => call.channel)
  expect(channels).toEqual(['connection:test-server'])
})

test('a remembered fingerprint passes without a second question and stays near-expiry visible', async ({
  mount,
  page
}) => {
  const component = await mount(<ConnectionScreenStory />)
  await enqueue(page, 'connection:test-server', {
    outcome: 'certificate-confirmation-required',
    ...CERTIFICATE_VIEW
  })
  await enqueue(page, 'connection:trust-certificate', { outcome: 'trusted' })
  const expiringSoon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toUTCString()
  await enqueue(page, 'connection:test-server', {
    outcome: 'reachable',
    certificateValidTo: expiringSoon
  })

  await fillAddressAndTest(component, 'https://deploy.example.com')
  await component.getByRole('button', { name: 'Trust this fingerprint' }).click()

  await expect(component.getByTestId('connection-probe-reachable')).toBeVisible()
  await expect(component.getByTestId('certificate-decision')).toHaveCount(0)
  await expect(component.getByTestId('certificate-near-expiry')).toContainText(expiringSoon)
  await expect(component.getByRole('button', { name: 'Save and continue' })).toBeEnabled()
})

test('a far-future certificate expiry stays silent on a reachable probe', async ({
  mount,
  page
}) => {
  const component = await mount(<ConnectionScreenStory />)
  await enqueue(page, 'connection:test-server', {
    outcome: 'reachable',
    certificateValidTo: 'Jan 1 00:00:00 2037 GMT'
  })

  await fillAddressAndTest(component, 'https://deploy.example.com')

  await expect(component.getByTestId('connection-probe-reachable')).toBeVisible()
  await expect(component.getByTestId('certificate-near-expiry')).toHaveCount(0)
})

test('a changed fingerprint warns instead of silently re-trusting', async ({ mount, page }) => {
  const component = await mount(<ConnectionScreenStory />)
  await enqueue(page, 'connection:test-server', {
    outcome: 'certificate-changed',
    ...CERTIFICATE_VIEW
  })

  await fillAddressAndTest(component, 'https://deploy.example.com')

  const decision = component.getByTestId('certificate-decision')
  await expect(decision).toBeVisible()
  await expect(decision.getByText('Server certificate fingerprint changed')).toBeVisible()
  await expect(component.getByRole('button', { name: 'Save and continue' })).toBeDisabled()
})

test('a development loopback plain-http address is probed and savable', async ({ mount, page }) => {
  const component = await mount(<ConnectionScreenStory />)
  await enqueue(page, 'connection:test-server', { outcome: 'reachable' })

  await fillAddressAndTest(component, 'http://127.0.0.1:8080')

  await expect(component.getByTestId('connection-probe-reachable')).toBeVisible()
  await expect(component.getByRole('button', { name: 'Save and continue' })).toBeEnabled()
})

test('a customer plain-http address is rejected by the authoritative probe', async ({
  mount,
  page
}) => {
  const component = await mount(<ConnectionScreenStory />)
  await enqueue(page, 'connection:test-server', { outcome: 'invalid-url' })

  await fillAddressAndTest(component, 'http://deploy.example.com')

  await expect(
    component.getByText('Invalid address: customer deployments require https')
  ).toBeVisible()
  await expect(component.getByRole('button', { name: 'Save and continue' })).toBeDisabled()
})

test('a reachable non-Nevix server is reported as incompatible', async ({ mount, page }) => {
  const component = await mount(<ConnectionScreenStory />)
  await enqueue(page, 'connection:test-server', { outcome: 'incompatible-server' })

  await fillAddressAndTest(component, 'http://127.0.0.1:9000')

  await expect(
    component.getByText('The server is reachable but is not a Nevix server')
  ).toBeVisible()
  await expect(component.getByRole('button', { name: 'Save and continue' })).toBeDisabled()
})

test('an expired certificate is a named connection defect, never a trust question', async ({
  mount,
  page
}) => {
  const component = await mount(<ConnectionScreenStory />)
  await enqueue(page, 'connection:test-server', {
    outcome: 'certificate-expired',
    ...CERTIFICATE_VIEW,
    validTo: 'Jan 1 00:00:00 2026 GMT'
  })

  await fillAddressAndTest(component, 'https://deploy.example.com')

  await expect(component.getByText(/expired on Jan 1 00:00:00 2026 GMT/)).toBeVisible()
  await expect(component.getByTestId('certificate-decision')).toHaveCount(0)
  await expect(component.getByRole('button', { name: 'Save and continue' })).toBeDisabled()
})

test('an unreachable address reports a retryable connection failure', async ({ mount, page }) => {
  const component = await mount(<ConnectionScreenStory />)
  await enqueue(page, 'connection:test-server', { outcome: 'unreachable' })

  await fillAddressAndTest(component, 'https://down.example.com')

  await expect(component.getByText('Could not reach the server')).toBeVisible()
  await expect(component.getByRole('button', { name: 'Save and continue' })).toBeDisabled()
})
