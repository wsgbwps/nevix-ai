import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expectWindowTitle, launchTestApp, signOutFromUserMenu } from '../helpers/electron-app'
import {
  createAuthUser,
  deleteAuthUser,
  readAuthHarnessConfig,
  uniqueAuthIdentity
} from '../auth/helpers/supabase-auth'

const authHarness = readAuthHarnessConfig()
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
    await expect(page.getByRole('radiogroup', { name })).toHaveCount(0)
  }
  await expect(page.getByRole('radio')).toHaveCount(0)
}

test('no language switch control is rendered anywhere on the unauthenticated boundary', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-unauthenticated-language-'))

  try {
    const launched = await launchForSystemLanguages(userDataDir, ['zh-CN'])
    try {
      await expect(launched.page.getByRole('heading', { name: '登录 Nevix AI' })).toBeVisible()
      await expectNoLanguageSwitchControl(launched.page)

      await launched.page.getByRole('button', { name: '创建账号', exact: true }).click()
      await expect(
        launched.page.getByRole('heading', { name: '创建你的 Nevix AI 账号' })
      ).toBeVisible()
      await expectNoLanguageSwitchControl(launched.page)

      await launched.page.getByRole('button', { name: '返回登录' }).click()
      await launched.page.getByRole('button', { name: '忘记密码？' }).click()
      await expect(launched.page.getByRole('heading', { name: '重置密码' })).toBeVisible()
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

test('Language Mode lives in the authenticated app shell, applies immediately, and persists per device', async () => {
  test.setTimeout(60_000)
  test.skip(!authHarness, 'requires the disposable Supabase Auth harness')
  if (!authHarness) return

  const identity = uniqueAuthIdentity('shell-language-mode')
  const userId = await createAuthUser(authHarness, identity, true)
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

      const languageModeGroup = launched.page.getByRole('radiogroup', { name: '界面语言' })
      await expect(languageModeGroup).toBeVisible()
      await expect(languageModeGroup.getByRole('radio')).toHaveCount(3)
      await expect(languageModeGroup.getByRole('radio', { name: '跟随系统' })).toHaveAttribute(
        'aria-checked',
        'true'
      )
      await expect(languageModeGroup.getByRole('radio', { name: '简体中文' })).toHaveCount(1)
      await expect(languageModeGroup.getByRole('radio', { name: 'English' })).toHaveCount(1)
      await expect(languageModeGroup.getByText('✓', { exact: true })).toBeVisible()

      let navigationCount = 0
      launched.page.on('framenavigated', (frame) => {
        if (frame === launched.page.mainFrame()) navigationCount += 1
      })

      await launched.page.getByRole('radio', { name: 'English' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      await expect(launched.page.getByRole('radio', { name: 'English' })).toHaveAttribute(
        'aria-checked',
        'true'
      )
      await expectWindowTitle(launched.electronApp, 'Nevix AI — Desktop')

      await launched.page.getByRole('radio', { name: 'Simplified Chinese' }).click()
      await expect(launched.page.getByRole('heading', { name: '使用 Nevix AI 创作' })).toBeVisible()
      await expectWindowTitle(launched.electronApp, 'Nevix AI — 桌面端')

      await launched.page.getByRole('radio', { name: 'English' }).click()
      await expect(
        launched.page.getByRole('heading', { name: 'Create with Nevix AI' })
      ).toBeVisible()
      expect(navigationCount).toBe(0)

      await signOutFromUserMenu(launched.page)
      await expect(
        launched.page.getByRole('heading', { name: 'Sign in to Nevix AI' })
      ).toBeVisible()
      await expectNoLanguageSwitchControl(launched.page)
    } finally {
      await launched.electronApp.close()
    }

    launched = await launchTestApp({ userDataDir, systemLanguages: ['zh-CN'] })
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
    await deleteAuthUser(authHarness, userId)
  }
})
