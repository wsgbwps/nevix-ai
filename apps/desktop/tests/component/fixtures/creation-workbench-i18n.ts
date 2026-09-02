import i18next from 'i18next'
import { createI18nOptions } from '../../../src/shared/i18n/i18next-options'
import { creationResources } from '../../../src/renderer/src/features/creation'

/**
 * The shared component-test i18n instance for the Creation Workbench stories
 * (plain module, not a component file, so stories stay react-refresh clean).
 * Carries top-level await: importers wait for the same initialized instance.
 */
export const testI18n = i18next.createInstance()
await testI18n.init(
  createI18nOptions({
    language: 'en',
    resources: creationResources,
    defaultNS: 'creation',
    environment: 'test'
  })
)
