import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'

const editModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const LANGUAGE_MODE_FILE_NAME = 'language-mode.json'

interface NativeMenuItemSnapshot {
  readonly role: string
  readonly label: string
  readonly enabled: boolean
}

async function captureContextMenuPopups(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ Menu }) => {
    const probe = globalThis as {
      __nevixNativeMenuSnapshots?: Array<Array<{ role: string; label: string; enabled: boolean }>>
    }
    probe.__nevixNativeMenuSnapshots = []

    Menu.prototype.popup = function (): void {
      probe.__nevixNativeMenuSnapshots?.push(
        this.items
          .filter((item) => item.type !== 'separator')
          .map((item) => ({ role: item.role, label: item.label, enabled: item.enabled }))
      )
    }
  })
}

async function readContextMenuPopups(
  electronApp: ElectronApplication
): Promise<readonly (readonly NativeMenuItemSnapshot[])[]> {
  return electronApp.evaluate(
    () =>
      (
        globalThis as {
          __nevixNativeMenuSnapshots?: Array<
            Array<{ role: string; label: string; enabled: boolean }>
          >
        }
      ).__nevixNativeMenuSnapshots ?? []
  )
}

async function writeClipboard(electronApp: ElectronApplication, text: string): Promise<void> {
  await electronApp.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
}

async function readClipboard(electronApp: ElectronApplication): Promise<string> {
  return electronApp.evaluate(({ clipboard }) => clipboard.readText())
}

async function pasteInto(
  electronApp: ElectronApplication,
  page: Page,
  locator: Locator,
  text: string
): Promise<void> {
  await writeClipboard(electronApp, text)
  await locator.click()
  await page.keyboard.press(`${editModifier}+V`)
}

test('the app exposes only managed hidden native edit accelerators', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-native-editing-menu-'))

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['en-US'],
      serverUrl: process.env.NEVIX_TEST_SERVER_URL
    })

    try {
      const applicationMenuItems = await launched.electronApp.evaluate(({ Menu }) => {
        const menu = Menu.getApplicationMenu()
        return menu?.items.map((item) => ({ role: item.role, visible: item.visible })) ?? []
      })

      expect(applicationMenuItems).toEqual([
        { role: 'undo', visible: false },
        { role: 'cut', visible: false },
        { role: 'copy', visible: false },
        { role: 'paste', visible: false },
        { role: 'delete', visible: false },
        { role: 'selectall', visible: false }
      ])
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('editable controls expose only native edit roles and standard accelerators change their value', async () => {
  test.skip(
    !process.env.NEVIX_TEST_SERVER_URL,
    'requires the configured build produced by the E2E command'
  )

  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-native-editing-'))
  await writeFile(
    join(userDataDir, LANGUAGE_MODE_FILE_NAME),
    JSON.stringify({ languageMode: 'en' }),
    'utf8'
  )

  try {
    const launched = await launchTestApp({
      userDataDir,
      systemLanguages: ['zh-CN'],
      serverUrl: process.env.NEVIX_TEST_SERVER_URL
    })

    try {
      await captureContextMenuPopups(launched.electronApp)
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()

      await launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' }).click({
        button: 'right'
      })
      await launched.page.waitForTimeout(100)
      expect(await readContextMenuPopups(launched.electronApp)).toEqual([])

      const email = launched.page.getByLabel('Email')
      await email.click()
      await launched.page.keyboard.type('editable draft')
      await email.selectText()
      await writeClipboard(launched.electronApp, 'clipboard value')
      await email.click({ button: 'right' })

      await expect.poll(() => readContextMenuPopups(launched.electronApp)).toHaveLength(1)
      expect((await readContextMenuPopups(launched.electronApp))[0]).toEqual([
        { role: 'undo', label: 'Undo', enabled: true },
        { role: 'cut', label: 'Cut', enabled: true },
        { role: 'copy', label: 'Copy', enabled: true },
        { role: 'paste', label: 'Paste', enabled: true },
        { role: 'delete', label: 'Delete', enabled: true },
        { role: 'selectall', label: 'Select All', enabled: true }
      ])

      const pastedValue = 'Native editing test value 42'
      await email.fill('')
      await pasteInto(launched.electronApp, launched.page, email, pastedValue)
      await expect(email).toHaveValue(pastedValue)

      await launched.page.keyboard.press(`${editModifier}+Z`)
      await expect(email).toHaveValue('')
      await launched.page.keyboard.press(`${editModifier}+V`)
      await launched.page.keyboard.press(`${editModifier}+A`)
      await launched.page.keyboard.press(`${editModifier}+C`)
      expect(await readClipboard(launched.electronApp)).toBe(pastedValue)

      await launched.page.keyboard.press(`${editModifier}+X`)
      await expect(email).toHaveValue('')
      expect(await readClipboard(launched.electronApp)).toBe(pastedValue)

      await launched.page.keyboard.press(`${editModifier}+V`)
      await launched.page.keyboard.press(`${editModifier}+A`)
      await launched.page.keyboard.press('Backspace')
      await expect(email).toHaveValue('')

      await launched.page.evaluate(() =>
        window.api.invoke('language:set-language-mode', { languageMode: 'zh-CN' })
      )
      await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      await launched.page.getByLabel('邮箱').click({ button: 'right' })

      await expect.poll(() => readContextMenuPopups(launched.electronApp)).toHaveLength(2)
      expect(
        (await readContextMenuPopups(launched.electronApp))[1]?.map(({ role, label }) => ({
          role,
          label
        }))
      ).toEqual([
        { role: 'undo', label: '撤销' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'delete', label: '删除' },
        { role: 'selectall', label: '全选' }
      ])

      const password = launched.page.getByLabel('密码')
      await pasteInto(launched.electronApp, launched.page, password, pastedValue)
      await expect(password).toHaveValue(pastedValue)
      await launched.page.keyboard.press(`${editModifier}+A`)
      await launched.page.keyboard.press('Backspace')
      await expect(password).toHaveValue('')
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})
