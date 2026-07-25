export const SUPPORTED_LANGUAGES = ['zh-CN', 'en'] as const

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export const FALLBACK_LANGUAGE: SupportedLanguage = 'zh-CN'

export type Translation = string | { readonly [key: string]: Translation }

type TranslationForShape<T extends Translation> = T extends string
  ? string
  : T extends { readonly [key: string]: Translation }
    ? { readonly [K in keyof T]: TranslationForShape<Extract<T[K], Translation>> }
    : never

export type SupportedLanguageResources = Readonly<Record<SupportedLanguage, Translation>>

export interface ResourceOwner {
  readonly namespace: string
  readonly resources: SupportedLanguageResources
}

export function defineResourceTranslations<const T extends Translation>(translations: {
  readonly 'zh-CN': T
  readonly en: TranslationForShape<T>
}): typeof translations {
  return translations
}

export function validateSupportedLanguageResources(
  resourceOwners: readonly ResourceOwner[]
): string[] {
  return resourceOwners.flatMap(validateResourceOwner)
}

function validateResourceOwner(resourceOwner: ResourceOwner): string[] {
  const fallbackResources = resourceOwner.resources[FALLBACK_LANGUAGE]

  if (!fallbackResources) {
    return [`${resourceOwner.namespace}.${FALLBACK_LANGUAGE} is missing`]
  }

  return validateTranslation(resourceOwner.namespace, fallbackResources, resourceOwner.resources)
}

function validateTranslation(
  path: string,
  fallbackTranslation: Translation,
  resources: SupportedLanguageResources
): string[] {
  if (typeof fallbackTranslation === 'string') {
    return SUPPORTED_LANGUAGES.flatMap((language) => {
      const value = translationAtPath(resources[language], path.split('.').slice(1))
      return typeof value === 'string' && value.trim().length > 0
        ? []
        : [`${language}:${path} is missing or empty`]
    })
  }

  return Object.entries(fallbackTranslation).flatMap(([key, value]) =>
    validateTranslation(`${path}.${key}`, value, resources)
  )
}

function translationAtPath(
  translation: Translation,
  path: readonly string[]
): Translation | undefined {
  return path.reduce<Translation | undefined>((current, key) => {
    if (!current || typeof current === 'string') return undefined
    return current[key]
  }, translation)
}
