import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expectWindowTitle, launchTestApp } from '../helpers/electron-app'

async function launchForSystemLanguages(
  systemLanguages: readonly string[]
): Promise<Awaited<ReturnType<typeof launchTestApp>> & { userDataDir: string }> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-i18n-'))
  const launched = await launchTestApp({
    userDataDir,
    systemLanguages
  })

  return { ...launched, userDataDir }
}

async function close({
  electronApp,
  userDataDir
}: Awaited<ReturnType<typeof launchForSystemLanguages>>): Promise<void> {
  await electronApp.close()
  await rm(userDataDir, { recursive: true, force: true })
}

test('the app does not expose an unmanaged native menu', async () => {
  const launched = await launchForSystemLanguages(['en-US'])

  try {
    const hasApplicationMenu = await launched.electronApp.evaluate(
      ({ Menu }) => Menu.getApplicationMenu() !== null
    )
    expect(hasApplicationMenu).toBe(false)
  } finally {
    await close(launched)
  }
})

test('startup selects a matching Interface Language for the highest-priority system language', async () => {
  const cases = [
    {
      systemLanguages: ['zh-Hant-TW', 'en-US'],
      heading: '登录 Nevix AI',
      title: 'Nevix AI — 桌面端'
    },
    {
      systemLanguages: ['en-GB', 'zh-CN'],
      heading: 'Sign in to Nevix AI',
      title: 'Nevix AI — Desktop'
    },
    {
      systemLanguages: ['fr-FR', 'en-US'],
      heading: '登录 Nevix AI',
      title: 'Nevix AI — 桌面端'
    }
  ]

  for (const expected of cases) {
    const launched = await launchForSystemLanguages(expected.systemLanguages)
    try {
      await expect(launched.page.getByRole('heading', { name: expected.heading })).toBeVisible()
      await expectWindowTitle(launched.electronApp, expected.title)
    } finally {
      await close(launched)
    }
  }
})
