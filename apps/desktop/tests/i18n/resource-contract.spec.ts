import { expect, test } from '@playwright/test'
import i18next from 'i18next'
import { createI18nOptions } from '../../src/shared/i18n/i18next-options'
import { DEFAULT_LANGUAGE_MODE } from '../../src/shared/i18n/language-mode'
import {
  SUPPORTED_LANGUAGES,
  validateSupportedLanguageResources
} from '../../src/shared/i18n/resource-contract'
import { windowResourceOwner } from '../../src/main/i18n/resources'
import { appResourceOwner } from '../../src/renderer/src/app/i18n'

const resourceOwners = [windowResourceOwner, appResourceOwner]

test('each Supported Language has complete non-empty resources for every namespace', () => {
  expect(SUPPORTED_LANGUAGES).toEqual(['zh-CN', 'en'])
  expect(DEFAULT_LANGUAGE_MODE).toBe('follow-system')
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
