import 'i18next'
import type { windowResources } from './resources'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'window'
    resources: typeof windowResources.en
    strictKeyChecks: true
  }
}
