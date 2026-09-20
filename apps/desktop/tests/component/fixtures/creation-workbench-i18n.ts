import i18next from 'i18next'
import { createI18nOptions } from '../../../src/shared/i18n/i18next-options'
import { appResources } from '../../../src/renderer/src/app/i18n'
import { creationResources } from '../../../src/renderer/src/features/creation'

/**
 * Shared CT i18n for the Creation Workbench stories — a plain module (react-refresh
 * clean) whose top-level await makes importers wait on one instance. The test
 * environment throws on every missing key, so every namespace the chrome needs is listed.
 */
const storyResources = {
  'zh-CN': { ...appResources['zh-CN'], ...creationResources['zh-CN'] },
  en: { ...appResources.en, ...creationResources.en }
}

export const testI18n = i18next.createInstance()
await testI18n.init(
  createI18nOptions({
    language: 'en',
    resources: storyResources,
    defaultNS: 'creation',
    environment: 'test'
  })
)
