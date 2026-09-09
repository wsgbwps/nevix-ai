import { expect, test } from '@playwright/experimental-ct-react'
import {
  ObjectStorageConnectionAdminEmptyStory,
  ObjectStorageConnectionAdminReadyStory,
  ObjectStorageConnectionCredentialUnavailableStory,
  ObjectStorageConnectionMemberStory
} from './fixtures/object-storage-connection-settings.story'

test('Admin configures an unconfigured connection through the exact proof and sees only masked state', async ({
  mount,
  page
}) => {
  const component = await mount(<ObjectStorageConnectionAdminEmptyStory />)
  await expect(component.getByText('Object storage is not configured yet.')).toBeVisible()

  await component.getByLabel('Provider').selectOption('oss')
  await component.getByLabel('Region').fill('cn-hangzhou')
  await component.getByLabel('Bucket').fill('nevix-reference-materials')
  await component.getByLabel('Access Key ID').fill('LTAI1234567890')
  await component.getByLabel('Secret Access Key').fill('candidate-secret')
  await component.getByRole('button', { name: 'Save and verify' }).click()

  await expect(component.getByText('Alibaba Cloud OSS', { exact: true })).toBeVisible()
  await expect(component.getByText('nevix-reference-materials')).toBeVisible()
  await expect(component.getByText('Revision 7')).toBeVisible()
  await expect(component.getByText('****7890')).toBeVisible()
  await expect(component.getByText('Configured')).toBeVisible()
  await expect(component.getByLabel('Access Key ID')).toHaveCount(0)
  await expect(component.getByLabel('Secret Access Key')).toHaveCount(0)

  expect(await page.evaluate(() => window.__objectStorageConnectionTest?.proofCalls())).toEqual([
    'create'
  ])
  expect(
    await page.evaluate(() => window.__objectStorageConnectionTest?.wireCalls())
  ).toContainEqual({
    method: 'POST',
    path: '/creation/object-storage-connection'
  })
})

test('a failed candidate stays editable and reports only stable safe guidance', async ({
  mount,
  page
}) => {
  const component = await mount(<ObjectStorageConnectionAdminEmptyStory />)
  await page.evaluate(() => window.__objectStorageConnectionTest?.respondCreateWith('unavailable'))
  await component.getByLabel('Region').fill('cn-hangzhou')
  await component.getByLabel('Bucket').fill('nevix-reference-materials')
  await component.getByLabel('Access Key ID').fill('LTAI1234567890')
  await component.getByLabel('Secret Access Key').fill('candidate-secret')
  await component.getByRole('button', { name: 'Save and verify' }).click()

  await expect(component.getByText('Object storage is not configured yet.')).toBeVisible()
  await expect(component.getByText(/could not be verified/i)).toBeVisible()
  await expect(component.getByText(/cors/i)).toHaveCount(0)
  await expect(component.getByLabel('Access Key ID')).toHaveValue('LTAI1234567890')
})

test('dirty inputs report discard semantics and the discard clears the credential draft', async ({
  mount,
  page
}) => {
  const component = await mount(<ObjectStorageConnectionAdminEmptyStory />)
  await component.getByLabel('Secret Access Key').fill('candidate-secret')

  await expect
    .poll(() =>
      page.evaluate(() => {
        const contribution = window.__objectStorageConnectionTest?.contribution()
        return contribution === undefined
          ? undefined
          : { navigate: contribution.navigate, close: contribution.close }
      })
    )
    .toEqual({ navigate: 'confirm-discard', close: 'confirm' })

  await page.evaluate(() => window.__objectStorageConnectionTest?.discard())
  await expect(component.getByLabel('Secret Access Key')).toHaveValue('')
})

test('Admin ready and credential-unavailable views stay masked', async ({ mount }) => {
  const ready = await mount(<ObjectStorageConnectionAdminReadyStory />)
  await expect(ready.getByText('****7890')).toBeVisible()
  await expect(ready.getByText('candidate-secret')).toHaveCount(0)
  await ready.unmount()

  const unavailable = await mount(<ObjectStorageConnectionCredentialUnavailableStory />)
  await expect(unavailable.getByText('Credential unavailable')).toBeVisible()
  await expect(unavailable.getByText('****7890')).toBeVisible()
  await expect(unavailable.getByLabel('Secret Access Key')).toHaveCount(0)
})

test('Member sees only generic contact-Admin guidance and performs no storage lookup', async ({
  mount,
  page
}) => {
  const component = await mount(<ObjectStorageConnectionMemberStory />)
  await expect(
    component.getByText('Object storage is unavailable. Contact an administrator.')
  ).toBeVisible()
  await expect(component.getByText('Alibaba Cloud OSS')).toHaveCount(0)
  await expect(component.getByText('nevix-reference-materials')).toHaveCount(0)
  await expect(component.getByText('Credential unavailable')).toHaveCount(0)
  await expect(component.getByRole('button', { name: 'Save and verify' })).toHaveCount(0)
  expect(await page.evaluate(() => window.__objectStorageConnectionTest?.wireCalls())).toEqual([])
})
