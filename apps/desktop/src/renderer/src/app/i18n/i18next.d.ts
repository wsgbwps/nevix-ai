import 'i18next'
import type { appResources } from '.'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'app'
    resources: typeof appResources.en
    strictKeyChecks: true
  }
}
