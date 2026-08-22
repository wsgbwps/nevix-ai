import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { seedServerConnection } from './server-connection'

const desktopRoot = join(__dirname, '../..')
const appEntry = join(desktopRoot, 'out/main/index.js')

interface LaunchTestAppOptions {
  readonly userDataDir: string
  readonly systemLanguages: readonly string[]
  /** When set, the device boots already connected to this server URL. */
  readonly serverUrl?: string
  readonly offline?: boolean
  readonly environment?: Readonly<Record<string, string>>
}

const FORBIDDEN_CHILD_ENVIRONMENT_KEYS = [
  'ADMIN_EMAIL',
  'ADMIN_INITIAL_PASSWORD',
  'DATABASE_URL',
  'DB_URL',
  'JWT_SECRET',
  'MIGRATION_DATABASE_URL',
  'NEVIX_TEST_ADMIN_EMAIL',
  'NEVIX_TEST_ADMIN_INITIAL_PASSWORD',
  'NEVIX_TEST_IDENTITY_SERVER_FAILURE_MARKER_DIR',
  'POSTGRES_PASSWORD',
  'POSTGRES_URL',
  'SMTP_PASS'
] as const

function desktopProcessEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const key of FORBIDDEN_CHILD_ENVIRONMENT_KEYS) delete environment[key]
  return environment
}

interface TestDiagnostics {
  readonly record: (source: string, message: string) => void
  readonly captureScreenshot: (page: Page, name: string) => Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

function createTestDiagnostics(): TestDiagnostics {
  const testInfo = test.info()
  const diagnosticsPath = testInfo.outputPath('electron.log')
  mkdirSync(dirname(diagnosticsPath), { recursive: true })

  const record = (source: string, message: string): void => {
    const line = `${new Date().toISOString()} [${source}] ${message}\n`
    try {
      appendFileSync(diagnosticsPath, line, 'utf8')
    } catch {
      process.stderr.write(line)
    }
  }

  return {
    record,
    async captureScreenshot(page, name): Promise<void> {
      const screenshotPath = testInfo.outputPath(name)
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true })
        record('artifact', `captured ${screenshotPath}`)
      } catch (error) {
        record('artifact', `screenshot failed: ${errorMessage(error)}`)
      }
    }
  }
}

function observeElectronApp(electronApp: ElectronApplication, diagnostics: TestDiagnostics): void {
  electronApp.on('console', (message) => {
    diagnostics.record(`main:console:${message.type()}`, message.text())
  })
  electronApp.process().stderr?.on('data', (data) => {
    diagnostics.record('main:stderr', String(data).trimEnd())
  })
}

function observeRenderer(page: Page, diagnostics: TestDiagnostics): void {
  page.on('console', (message) => {
    diagnostics.record(`renderer:console:${message.type()}`, message.text())
  })
  page.on('pageerror', (error) => {
    diagnostics.record('renderer:pageerror', errorMessage(error))
    void diagnostics.captureScreenshot(page, 'renderer-pageerror.png')
  })
  page.on('crash', () => {
    diagnostics.record('renderer:crash', `renderer crashed at ${page.url()}`)
  })
}

async function waitForRendererReady(page: Page, diagnostics: TestDiagnostics): Promise<void> {
  try {
    await page.waitForLoadState('domcontentloaded')
    await page.locator('#root > *').first().waitFor({ state: 'attached' })
    diagnostics.record('renderer:ready', page.url())
  } catch (error) {
    diagnostics.record('renderer:readiness', errorMessage(error))
    await diagnostics.captureScreenshot(page, 'renderer-readiness-failure.png')
    throw error
  }
}

export async function launchTestApp({
  userDataDir,
  systemLanguages,
  serverUrl,
  offline = false,
  environment = {}
}: LaunchTestAppOptions): Promise<{ electronApp: ElectronApplication; page: Page }> {
  const testEnvironment = { ...environment }
  for (const key of FORBIDDEN_CHILD_ENVIRONMENT_KEYS) delete testEnvironment[key]
  const diagnostics = createTestDiagnostics()

  if (serverUrl) await seedServerConnection(userDataDir, serverUrl)

  const electronApp = await electron.launch({
    args: [appEntry, `--user-data-dir=${userDataDir}`],
    cwd: desktopRoot,
    env: {
      ...desktopProcessEnvironment(),
      ...testEnvironment,
      NEVIX_E2E: '1',
      NEVIX_TEST_SYSTEM_LANGUAGES: systemLanguages.join(','),
      NEVIX_TEST_USER_DATA_DIR: userDataDir
    }
  })
  observeElectronApp(electronApp, diagnostics)

  if (offline) {
    await electronApp.evaluate(({ session }) => {
      session.defaultSession.enableNetworkEmulation({ offline: true })
    })
  }

  const page = await electronApp.firstWindow()
  observeRenderer(page, diagnostics)
  if (offline) {
    await page.waitForLoadState('domcontentloaded')
    await page.route(/^https?:\/\//, (route) => route.abort('internetdisconnected'))
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) throw new Error('Main window was not created')
      await mainWindow.loadURL(mainWindow.webContents.getURL())
    })
  }

  await waitForRendererReady(page, diagnostics)

  return { electronApp, page }
}

/**
 * Reports whether the current platform offers a secure persistence backend for the Session:
 * a native Keychain, DPAPI, or Secret Service. Linux's basic_text fallback stores plaintext
 * and is treated as unavailable, so no Session is persisted there by design.
 */
export async function hasSecurePersistenceBackend(
  electronApp: ElectronApplication
): Promise<boolean> {
  return electronApp.evaluate(({ safeStorage }) => {
    if (!safeStorage.isEncryptionAvailable()) return false
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
  })
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

/** Requests the same ordinary close lifecycle as the main window's native close control. */
export async function requestOrdinaryWindowClose(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (!mainWindow) throw new Error('Main window was not created')
    mainWindow.close()
  })
}

export async function expectMainWindowCount(
  electronApp: ElectronApplication,
  expectedCount: number
): Promise<void> {
  await expect
    .poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
    .toBe(expectedCount)
}

/**
 * Opens the Settings Page through the App Shell user menu: opens the NavUser menu and activates
 * its Settings item. The shell renders both the menu trigger and the item through the Interface
 * Language, so both names are matched in the two Supported Languages. When the menu is already
 * open, the trigger is excluded from the accessibility tree (Radix modal menu), so only the
 * Settings item is activated.
 */
export async function openSettingsFromUserMenu(page: Page): Promise<void> {
  const menu = page.getByRole('menu')
  if ((await menu.count()) === 0) {
    await page.getByRole('button', { name: /user menu|用户菜单/i }).click()
  }
  await page.getByRole('menuitem', { name: /settings|设置/i }).click()
}

export async function openSettingsSectionFromUserMenu(
  page: Page,
  sectionName: string
): Promise<void> {
  await openSettingsFromUserMenu(page)
  await page
    .getByRole('navigation', { name: /^(Settings|设置)$/ })
    .getByRole('button', { name: sectionName, exact: true })
    .click()
}

/**
 * Signs the current Session out through the App Shell user menu: opens the NavUser menu and
 * activates its sign-out item. The shell renders both the menu trigger and the item through the
 * Interface Language, so both names are matched in the two Supported Languages. When the menu is
 * already open, the trigger is excluded from the accessibility tree (Radix modal menu), so only
 * the sign-out item is activated.
 */
export async function signOutFromUserMenu(page: Page): Promise<void> {
  const menu = page.getByRole('menu')
  if ((await menu.count()) === 0) {
    await page.getByRole('button', { name: /user menu|用户菜单/i }).click()
  }
  await page.getByRole('menuitem', { name: /sign out of this device|退出当前设备/i }).click()
}
