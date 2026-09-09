import { expect, test } from '@playwright/experimental-ct-react'
import {
  ObjectStorageConnectionAdminEmptyStory,
  ObjectStorageConnectionAdminFrozenStory,
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

test('Admin rechecks without proof and can start each exact maintenance action', async ({
  mount,
  page
}) => {
  const component = await mount(<ObjectStorageConnectionAdminReadyStory />)

  await component.getByRole('button', { name: 'Recheck saved credential' }).click()
  await expect(component.getByText('Completed · 2026-09-09T06:00:00Z')).toBeVisible()
  expect(await page.evaluate(() => window.__objectStorageConnectionTest?.proofCalls())).toEqual([])
  expect(
    await page.evaluate(() => window.__objectStorageConnectionTest?.wireCalls())
  ).toContainEqual({
    method: 'POST',
    path: '/creation/object-storage-connection/recheck'
  })

  await component.getByRole('button', { name: 'Replace location' }).click()
  await expect(
    component.getByRole('dialog', { name: 'Replace object storage location' })
  ).toBeVisible()
  expect(await page.evaluate(() => window.__objectStorageConnectionTest?.proofCalls())).toEqual([
    'replace'
  ])
  await component.getByRole('button', { name: 'Cancel' }).click()

  await component.getByRole('button', { name: 'Rotate credential' }).click()
  const rotateDialog = component.getByRole('dialog', { name: 'Rotate object storage credential' })
  await expect(rotateDialog).toBeVisible()
  await expect(
    rotateDialog.getByText(/retain the old cloud key for at least 24 hours/i)
  ).toBeVisible()
  await expect(rotateDialog.getByText(/fail closed/i)).toBeVisible()
  expect(await page.evaluate(() => window.__objectStorageConnectionTest?.proofCalls())).toEqual([
    'replace',
    'rotate'
  ])
  await rotateDialog.getByRole('button', { name: 'Cancel' }).click()

  await component.getByRole('button', { name: 'Delete connection' }).click()
  const deleteDialog = component.getByRole('dialog', { name: 'Delete object storage connection?' })
  await expect(deleteDialog).toBeVisible()
  await deleteDialog.getByRole('button', { name: 'Delete connection' }).click()
  await expect(component.getByText('Object storage is not configured yet.')).toBeVisible()
  expect(await page.evaluate(() => window.__objectStorageConnectionTest?.proofCalls())).toEqual([
    'replace',
    'rotate',
    'delete'
  ])
  expect(
    await page.evaluate(() => window.__objectStorageConnectionTest?.wireCalls())
  ).toContainEqual({
    method: 'DELETE',
    path: '/creation/object-storage-connection'
  })
})

test('credential-unavailable state prominently offers proof-protected recovery', async ({
  mount,
  page
}) => {
  const component = await mount(<ObjectStorageConnectionCredentialUnavailableStory />)

  await expect(component.getByRole('alert')).toContainText('Recovery is required')
  await component.getByRole('button', { name: 'Recover credential' }).click()
  await expect(
    component.getByRole('dialog', { name: 'Recover object storage credential' })
  ).toBeVisible()
  expect(await page.evaluate(() => window.__objectStorageConnectionTest?.proofCalls())).toEqual([
    'recover'
  ])
})

test('a frozen location disables replace and delete while leaving recheck and rotation available', async ({
  mount
}) => {
  const component = await mount(<ObjectStorageConnectionAdminFrozenStory />)

  await expect(component.getByText('The storage location is frozen')).toBeVisible()
  await expect(component.getByRole('button', { name: 'Replace location' })).toBeDisabled()
  await expect(component.getByRole('button', { name: 'Delete connection' })).toBeDisabled()
  await expect(component.getByRole('button', { name: 'Recheck saved credential' })).toBeEnabled()
  await expect(component.getByRole('button', { name: 'Rotate credential' })).toBeEnabled()
})

test('a failed credential candidate keeps the old masked connection and spends its proof', async ({
  mount,
  page
}) => {
  const component = await mount(<ObjectStorageConnectionAdminReadyStory />)
  await page.evaluate(() =>
    window.__objectStorageConnectionTest?.respondMaintenanceWith('revision-conflict')
  )

  await component.getByRole('button', { name: 'Rotate credential' }).click()
  const dialog = component.getByRole('dialog', { name: 'Rotate object storage credential' })
  await dialog.getByLabel('Access Key ID').fill('replacement-access-key')
  await dialog.getByLabel('Secret Access Key').fill('replacement-secret')
  await dialog.getByRole('button', { name: 'Verify and save' }).click()

  await expect(dialog).toBeHidden()
  await expect(component.getByText('Revision 7')).toBeVisible()
  await expect(component.getByText('****7890')).toBeVisible()
  await expect(component.getByText('The Object Storage Connection changed.')).toBeVisible()
  expect(await page.evaluate(() => window.__objectStorageConnectionTest?.proofCalls())).toEqual([
    'rotate'
  ])
  expect(
    await page.evaluate(() => window.__objectStorageConnectionTest?.wireCalls())
  ).toContainEqual({
    method: 'PUT',
    path: '/creation/object-storage-connection/credential'
  })
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
