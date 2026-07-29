import { expect, test } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expectWindowTitle, launchTestApp } from '../helpers/electron-app'

async function launchForSystemLanguages(
  userDataDir: string,
  systemLanguages: readonly string[]
): ReturnType<typeof launchTestApp> {
  return launchTestApp({
    userDataDir,
    systemLanguages,
    offline: true
  })
}

test('a corrupt or unknown saved Language Mode falls back to follow-system', async () => {
  const cases = [
    {
      storedValue: '{',
      systemLanguages: ['en-US'],
      heading: 'Sign in to Nevix AI',
      languageGroup: 'Interface language',
      followSystem: 'Follow system'
    },
    {
      storedValue: JSON.stringify({ languageMode: 'fr' }),
      systemLanguages: ['zh-CN'],
      heading: '登录 Nevix AI',
      languageGroup: '界面语言',
      followSystem: '跟随系统'
    }
  ] as const

  for (const expected of cases) {
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-invalid-language-mode-'))
    await writeFile(join(userDataDir, 'language-mode.json'), expected.storedValue, 'utf8')

    try {
      const launched = await launchForSystemLanguages(userDataDir, expected.systemLanguages)
      try {
        await expect(launched.page.getByRole('heading', { name: expected.heading })).toBeVisible()
        await expect(
          launched.page
            .getByRole('radiogroup', { name: expected.languageGroup })
            .getByRole('radio', { name: expected.followSystem })
        ).toHaveAttribute('aria-checked', 'true')
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
})

test('Language Mode is available offline without an account, updates immediately, and persists per device', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-language-mode-'))

  try {
    let launched = await launchForSystemLanguages(userDataDir, ['zh-CN'])
    try {
      await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      const languageModeGroup = launched.page.getByRole('radiogroup', { name: '界面语言' })
      await expect(languageModeGroup).toBeVisible()
      await expect(languageModeGroup.getByRole('radio')).toHaveCount(3)
      await expect(languageModeGroup.getByRole('radio', { name: '跟随系统' })).toHaveCount(1)
      await expect(languageModeGroup.getByRole('radio', { name: '简体中文' })).toHaveCount(1)
      await expect(languageModeGroup.getByRole('radio', { name: 'English' })).toHaveCount(1)
      await expect(languageModeGroup.getByRole('radio', { name: '跟随系统' })).toHaveAttribute(
        'aria-checked',
        'true'
      )
      await expect(languageModeGroup.getByText('✓', { exact: true })).toBeVisible()

      let navigationCount = 0
      launched.page.on('framenavigated', (frame) => {
        if (frame === launched.page.mainFrame()) navigationCount += 1
      })
      await launched.page.getByRole('radio', { name: 'English' }).click()

      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expect(
        launched.page.getByRole('radiogroup', { name: 'Interface language' })
      ).toBeVisible()
      await expect(launched.page.getByRole('radio', { name: 'English' })).toHaveAttribute(
        'aria-checked',
        'true'
      )
      await expect(
        launched.page
          .getByRole('radiogroup', { name: 'Interface language' })
          .getByText('✓', { exact: true })
      ).toBeVisible()
      await expectWindowTitle(launched.electronApp, 'Nevix AI — Desktop')
      expect(navigationCount).toBe(0)

      await launched.page.getByRole('radio', { name: 'Simplified Chinese' }).click()
      await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      await expectWindowTitle(launched.electronApp, 'Nevix AI — 桌面端')

      await launched.page.getByRole('radio', { name: 'English' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
    } finally {
      await launched.electronApp.close()
    }

    launched = await launchForSystemLanguages(userDataDir, ['zh-CN'])
    try {
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expectWindowTitle(launched.electronApp, 'Nevix AI — Desktop')

      await launched.page.getByRole('radio', { name: 'Follow system' }).click()
      await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      await expectWindowTitle(launched.electronApp, 'Nevix AI — 桌面端')
    } finally {
      await launched.electronApp.close()
    }

    launched = await launchForSystemLanguages(userDataDir, ['en-US'])
    try {
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expectWindowTitle(launched.electronApp, 'Nevix AI — Desktop')
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})
