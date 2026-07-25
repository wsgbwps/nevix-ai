import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const desktopRoot = join(__dirname, '../..')
const appEntry = join(desktopRoot, 'out/main/index.js')

async function launchForSystemLanguages(
  userDataDir: string,
  systemLanguages: readonly string[]
): Promise<{ electronApp: ElectronApplication; page: Page }> {
  const electronApp = await electron.launch({
    args: [appEntry, `--user-data-dir=${userDataDir}`],
    cwd: desktopRoot,
    env: {
      ...process.env,
      NEVIX_E2E: '1',
      NEVIX_TEST_SYSTEM_LANGUAGES: systemLanguages.join(','),
      NEVIX_TEST_USER_DATA_DIR: userDataDir
    }
  })

  return { electronApp, page: await electronApp.firstWindow() }
}

async function close(electronApp: ElectronApplication): Promise<void> {
  await electronApp.close()
}

async function expectWindowTitle(
  electronApp: ElectronApplication,
  expectedTitle: string
): Promise<void> {
  await expect
    .poll(() =>
      electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle())
    )
    .toBe(expectedTitle)
}

test('a corrupt or unknown saved Language Mode falls back to follow-system', async () => {
  const cases = [
    {
      storedValue: '{',
      systemLanguages: ['en-US'],
      heading: 'Create with Nevix AI',
      languageGroup: 'Interface language',
      followSystem: 'Follow system'
    },
    {
      storedValue: JSON.stringify({ languageMode: 'fr' }),
      systemLanguages: ['zh-CN'],
      heading: '使用 Nevix AI 创作',
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
        await close(launched.electronApp)
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
})

test('Language Mode is available without an account, updates immediately, and persists per device', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-language-mode-'))

  try {
    let launched = await launchForSystemLanguages(userDataDir, ['zh-CN'])
    try {
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()
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
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
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
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()
      await expectWindowTitle(launched.electronApp, 'Nevix AI — 桌面端')

      await launched.page.getByRole('radio', { name: 'English' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
    } finally {
      await close(launched.electronApp)
    }

    launched = await launchForSystemLanguages(userDataDir, ['zh-CN'])
    try {
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      await expectWindowTitle(launched.electronApp, 'Nevix AI — Desktop')

      await launched.page.getByRole('radio', { name: 'Follow system' }).click()
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()
      await expectWindowTitle(launched.electronApp, 'Nevix AI — 桌面端')
    } finally {
      await close(launched.electronApp)
    }

    launched = await launchForSystemLanguages(userDataDir, ['en-US'])
    try {
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      await expectWindowTitle(launched.electronApp, 'Nevix AI — Desktop')
    } finally {
      await close(launched.electronApp)
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})
