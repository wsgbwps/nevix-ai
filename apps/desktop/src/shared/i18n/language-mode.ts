import type { SupportedLanguage } from './resource-contract'

export const LANGUAGE_MODES = ['follow-system', 'zh-CN', 'en'] as const

export type LanguageMode = (typeof LANGUAGE_MODES)[number]

export const DEFAULT_LANGUAGE_MODE: LanguageMode = 'follow-system'

export function interfaceLanguageForMode(
  languageMode: LanguageMode,
  systemLanguages: readonly string[]
): SupportedLanguage {
  if (languageMode !== 'follow-system') return languageMode

  const languageFamily = systemLanguages[0]
    ?.trim()
    .replace('_', '-')
    .split('-', 1)[0]
    ?.toLowerCase()
  return languageFamily === 'en' ? 'en' : 'zh-CN'
}
