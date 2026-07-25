import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const desktopRoot = join(__dirname, '../..')
const appEntry = join(desktopRoot, 'out/main/index.js')

async function launchForSystemLanguages(
  systemLanguages: readonly string[]
): Promise<{ electronApp: ElectronApplication; page: Page; userDataDir: string }> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-i18n-'))
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

  return { electronApp, page: await electronApp.firstWindow(), userDataDir }
}

async function close({
  electronApp,
  userDataDir
}: {
  electronApp: ElectronApplication
  userDataDir: string
}): Promise<void> {
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
      heading: '使用 Nevix AI 创作',
      title: 'Nevix AI — 桌面端'
    },
    {
      systemLanguages: ['en-GB', 'zh-CN'],
      heading: 'Create with Nevix AI',
      title: 'Nevix AI — Desktop'
    },
    {
      systemLanguages: ['fr-FR', 'en-US'],
      heading: '使用 Nevix AI 创作',
      title: 'Nevix AI — 桌面端'
    }
  ]

  for (const expected of cases) {
    const launched = await launchForSystemLanguages(expected.systemLanguages)
    try {
      await expect(launched.page.getByRole('heading', { name: expected.heading })).toBeVisible()
      await expect
        .poll(() =>
          launched.electronApp.evaluate(({ BrowserWindow }) => {
            return BrowserWindow.getAllWindows()[0]?.getTitle()
          })
        )
        .toBe(expected.title)
    } finally {
      await close(launched)
    }
  }
})
