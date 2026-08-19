/**
 * Public interface of the Settings Flow module: the app-owned full-screen
 * Settings Page aggregation plus the entry-state builder its callers use to
 * capture a return source. Everything else — section registry, leave
 * semantics, discard prompts, ordinary-close orchestration, and the
 * back-navigation interception — is implementation behind this seam.
 */
export { SettingsPage } from './settings-page'
export { createSettingsEntry } from './settings-navigation'
