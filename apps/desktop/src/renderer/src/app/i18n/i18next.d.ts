import 'i18next'
import type { rendererResources } from './renderer-i18n'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'app'
    resources: typeof rendererResources.en
    strictKeyChecks: true
  }
}
