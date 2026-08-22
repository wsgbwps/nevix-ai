import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  expectWindowTitle,
  launchTestApp,
  openSettingsFromUserMenu,
  signOutFromUserMenu
} from '../helpers/electron-app'
import {
  createStableTeamUser,
  readIdentityServerConfig,
  uniqueIdentity
} from '../auth/helpers/identity-server'

const identityServer = readIdentityServerConfig()
const LANGUAGE_MODE_FILE_NAME = 'language-mode.json'
const languageGroupNames = ['界面语言', 'Interface language'] as const

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

async function expectNoLanguageSwitchControl(page: Page): Promise<void> {
  for (const name of languageGroupNames) {
    await expect(page.getByRole('combobox', { name })).toHaveCount(0)
  }
}

test('no language switch control is rendered anywhere on the unauthenticated boundary', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-unauthenticated-language-'))

  try {
    const launched = await launchForSystemLanguages(userDataDir, ['zh-CN'])
    try {
      await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      await expectNoLanguageSwitchControl(launched.page)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('a corrupt or unknown saved Language Mode falls back to follow-system', async () => {
  const cases = [
    {
      storedValue: '{',
      systemLanguages: ['en-US'],
      heading: 'Sign in to Nevix AI',
      title: 'Nevix AI — Desktop'
    },
    {
      storedValue: JSON.stringify({ languageMode: 'fr' }),
      systemLanguages: ['zh-CN'],
      heading: '登录 Nevix AI',
      title: 'Nevix AI — 桌面端'
    }
  ] as const

  for (const expected of cases) {
    const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-invalid-language-mode-'))
    await writeFile(join(userDataDir, LANGUAGE_MODE_FILE_NAME), expected.storedValue, 'utf8')

    try {
      const launched = await launchForSystemLanguages(userDataDir, expected.systemLanguages)
      try {
        await expect(launched.page.getByRole('heading', { name: expected.heading })).toBeVisible()
        await expectWindowTitle(launched.electronApp, expected.title)
        await expectNoLanguageSwitchControl(launched.page)
      } finally {
        await launched.electronApp.close()
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  }
})

test('a saved per-device Language Mode still resolves the login screen it cannot be changed from', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-saved-language-mode-'))
  await writeFile(
    join(userDataDir, LANGUAGE_MODE_FILE_NAME),
    JSON.stringify({ languageMode: 'en' }),
    'utf8'
  )

  try {
    const launched = await launchForSystemLanguages(userDataDir, ['zh-CN'])
    try {
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expectWindowTitle(launched.electronApp, 'Nevix AI — Desktop')
      await expectNoLanguageSwitchControl(launched.page)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})

test('Language Mode lives in the Settings Page, applies immediately, and persists per device', async () => {
  test.setTimeout(60_000)
  test.skip(!identityServer, 'requires the disposable identity server built by the E2E command')
  if (!identityServer) return

  const identity = uniqueIdentity('settings-language-mode')
  await createStableTeamUser(identityServer, identity)
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-language-mode-'))

  try {
    let launched = await launchTestApp({ userDataDir, systemLanguages: ['zh-CN'] })
    try {
      await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      await expectNoLanguageSwitchControl(launched.page)

      await launched.page.getByLabel('邮箱').fill(identity.email)
      await launched.page.getByLabel('密码').fill(identity.password)
      await launched.page.getByRole('button', { name: '登录', exact: true }).click()
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()
      await expectNoLanguageSwitchControl(launched.page)

      await openSettingsFromUserMenu(launched.page)
      await expect(launched.page.getByRole('heading', { name: '个人资料' })).toBeVisible()
      await launched.page
        .getByRole('navigation', { name: '设置' })
        .getByRole('button', {
          name: '语言'
        })
        .click()

      const languageModeSelect = launched.page.getByRole('combobox', { name: '界面语言' })
      await expect(languageModeSelect).toBeVisible()
      await expect(languageModeSelect).toContainText('跟随系统')

      await languageModeSelect.click()
      const languageModeOptions = launched.page.getByRole('option')
      await expect(languageModeOptions).toHaveCount(3)
      await expect(launched.page.getByRole('option', { name: '简体中文' })).toHaveCount(1)
      await expect(launched.page.getByRole('option', { name: 'English' })).toHaveCount(1)

      let navigationCount = 0
      launched.page.on('framenavigated', (frame) => {
        if (frame === launched.page.mainFrame()) navigationCount += 1
      })

      await launched.page.getByRole('option', { name: 'English' }).click()
      await expect(launched.page.getByRole('heading', { name: 'Language' })).toBeVisible()
      await expect(
        launched.page.getByRole('combobox', { name: 'Interface language' })
      ).toContainText('English')
      await expectWindowTitle(launched.electronApp, 'Nevix AI — Desktop')

      await launched.page.getByRole('button', { name: 'Back to app' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()

      await openSettingsFromUserMenu(launched.page)
      await expect(launched.page.getByRole('heading', { name: 'Profile' })).toBeVisible()
      await launched.page
        .getByRole('navigation', { name: 'Settings' })
        .getByRole('button', {
          name: 'Language'
        })
        .click()
      await launched.page.getByRole('combobox', { name: 'Interface language' }).click()
      await launched.page.getByRole('option', { name: 'Simplified Chinese' }).click()
      await expect(launched.page.getByRole('heading', { name: '语言' })).toBeVisible()
      await expect(launched.page.getByRole('combobox', { name: '界面语言' })).toContainText(
        '简体中文'
      )
      await expectWindowTitle(launched.electronApp, 'Nevix AI — 桌面端')

      await launched.page.getByRole('button', { name: '返回应用' }).click()
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()
      expect(navigationCount).toBe(0)

      await signOutFromUserMenu(launched.page)
      await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      await expectNoLanguageSwitchControl(launched.page)
    } finally {
      await launched.electronApp.close()
    }

    launched = await launchTestApp({ userDataDir, systemLanguages: ['zh-CN'] })
    try {
      await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      await expectWindowTitle(launched.electronApp, 'Nevix AI — 桌面端')
      await expectNoLanguageSwitchControl(launched.page)
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})
