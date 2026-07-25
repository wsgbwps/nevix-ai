import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { join } from 'node:path'

const desktopRoot = join(__dirname, '../..')
const appEntry = join(desktopRoot, 'out/main/index.js')

interface LaunchTestAppOptions {
  readonly userDataDir: string
  readonly systemLanguages: readonly string[]
  readonly offline?: boolean
}

export async function launchTestApp({
  userDataDir,
  systemLanguages,
  offline = false
}: LaunchTestAppOptions): Promise<{ electronApp: ElectronApplication; page: Page }> {
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

  const page = await electronApp.firstWindow()
  if (offline) {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) throw new Error('Main window was not created')
      mainWindow.webContents.session.enableNetworkEmulation({ offline: true })
    })
    await page.reload()
  }

  return { electronApp, page }
}

export async function expectWindowTitle(
  electronApp: ElectronApplication,
  expectedTitle: string
): Promise<void> {
  await expect
    .poll(() =>
      electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle())
    )
    .toBe(expectedTitle)
}
