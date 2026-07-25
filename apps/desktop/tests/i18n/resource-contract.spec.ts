import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import i18next from 'i18next'
import {
  macOSLocalizationPaths,
  missingMacOSPermissionKeys,
  nsisInstallerLanguages
} from '../../scripts/packaged-localization-contract.mjs'
import { createI18nOptions } from '../../src/shared/i18n/i18next-options'
import { DEFAULT_LANGUAGE_MODE, LANGUAGE_MODES } from '../../src/shared/i18n/language-mode'
import {
  SUPPORTED_LANGUAGES,
  validateSupportedLanguageResources
} from '../../src/shared/i18n/resource-contract'
import { windowResourceOwner } from '../../src/main/i18n/resources'
import { appResourceOwner } from '../../src/renderer/src/app/i18n'
import { settingsResourceOwner } from '../../src/renderer/src/features/settings'

const resourceOwners = [windowResourceOwner, appResourceOwner, settingsResourceOwner]

test('each Supported Language has complete non-empty resources for every namespace', () => {
  expect(SUPPORTED_LANGUAGES).toEqual(['zh-CN', 'en'])
  expect(DEFAULT_LANGUAGE_MODE).toBe('follow-system')
  expect(LANGUAGE_MODES).toEqual([DEFAULT_LANGUAGE_MODE, ...SUPPORTED_LANGUAGES])
  expect(validateSupportedLanguageResources(resourceOwners)).toEqual([])
})

test('an incomplete unregistered language does not become a Supported Language', () => {
  const ownerWithCandidate = {
    namespace: appResourceOwner.namespace,
    resources: {
      ...appResourceOwner.resources,
      fr: { heading: '' }
    }
  }

  expect(validateSupportedLanguageResources([ownerWithCandidate])).toEqual([])
  expect(SUPPORTED_LANGUAGES).not.toContain('fr')
})

test('each Supported Language has complete non-empty macOS permission explanations', async () => {
  expect(Object.keys(macOSLocalizationPaths).sort()).toEqual([...SUPPORTED_LANGUAGES].sort())

  for (const localizationPath of Object.values(macOSLocalizationPaths)) {
    const localization = await readFile(
      join(__dirname, '../../build/locales', localizationPath),
      'utf8'
    )
    expect(missingMacOSPermissionKeys(localization)).toEqual([])
  }
})

test('the macOS permission contract rejects whitespace-only explanations', () => {
  const localization = [
    '"NSCameraUsageDescription" = "   ";',
    '"NSMicrophoneUsageDescription" = "Microphone access";',
    '"NSDocumentsFolderUsageDescription" = "Documents access";',
    '"NSDownloadsFolderUsageDescription" = "Downloads access";'
  ].join('\n')

  expect(missingMacOSPermissionKeys(localization)).toEqual(['NSCameraUsageDescription'])
})

test('the NSIS installer enables every Supported Language', async () => {
  const builderConfig = await readFile(join(__dirname, '../../electron-builder.yml'), 'utf8')
  const installerLanguages = nsisInstallerLanguages
    .map((language) => `    - ${language}`)
    .join('\n')

  expect(nsisInstallerLanguages).toEqual(['en_US', 'zh_CN'])
  expect(builderConfig).toContain(`  installerLanguages:\n${installerLanguages}`)
})

test('a missing formal translation falls back only in production and reports in test', async () => {
  const incompleteResources = {
    'zh-CN': { app: { heading: '使用 Nevix AI 创作' } },
    en: { app: {} }
  }

  const productionI18n = i18next.createInstance()
  await productionI18n.init(
    createI18nOptions({
      language: 'en',
      resources: incompleteResources,
      defaultNS: 'app',
      environment: 'production'
    })
  )
  expect(productionI18n.t('heading')).toBe('使用 Nevix AI 创作')

  const testI18n = i18next.createInstance()
  await testI18n.init(
    createI18nOptions({
      language: 'en',
      resources: incompleteResources,
      defaultNS: 'app',
      environment: 'test'
    })
  )
  expect(() => testI18n.t('heading')).toThrow('Missing translation key: heading')
})
