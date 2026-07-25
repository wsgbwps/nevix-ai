import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './resource-contract'

export const LANGUAGE_MODES = ['follow-system', ...SUPPORTED_LANGUAGES] as const

export type LanguageMode = (typeof LANGUAGE_MODES)[number]

export const DEFAULT_LANGUAGE_MODE: LanguageMode = 'follow-system'

export function isLanguageMode(value: unknown): value is LanguageMode {
  return typeof value === 'string' && LANGUAGE_MODES.includes(value as LanguageMode)
}

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
