import i18next from 'i18next'
import { createI18nOptions } from '../../../src/shared/i18n/i18next-options'
import { appResources } from '../../../src/renderer/src/app/i18n'
import { creationResources } from '../../../src/renderer/src/features/creation'

/**
 * The shared component-test i18n instance for the Creation Workbench stories
 * (plain module, not a component file, so stories stay react-refresh clean).
 * Carries top-level await: importers wait for the same initialized instance.
 * Composes the two namespaces these stories mount — the App Shell brand slot
 * (`app`) and the Creation surfaces (`creation`) — per language, the same way
 * `renderer-i18n.ts` composes its set. The test environment's options turn
 * every missing key into a thrown error, so a namespace the chrome needs has
 * to be listed here.
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
