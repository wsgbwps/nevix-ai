import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LanguageMode } from '../../../../../shared/i18n/language-mode'

const languageModeOptions = [
  { value: 'follow-system', translationKey: 'followSystem' },
  { value: 'zh-CN', translationKey: 'zhCN' },
  { value: 'en', translationKey: 'en' }
] as const

export function LanguageModeSettings(): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [languageMode, setLanguageMode] = useState<LanguageMode | undefined>()
  const [isUpdating, setIsUpdating] = useState(false)

  useEffect(() => {
    let isMounted = true
    const unsubscribe = window.api.on('settings:language-mode-changed', (settings) => {
      if (isMounted) setLanguageMode(settings.languageMode)
    })

    void window.api.invoke('settings:get-language-mode').then((settings) => {
      if (isMounted) setLanguageMode(settings.languageMode)
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [])

  function selectLanguageMode(nextLanguageMode: LanguageMode): void {
    if (isUpdating || languageMode === nextLanguageMode) return

    setIsUpdating(true)
    void window.api
      .invoke('settings:set-language-mode', { languageMode: nextLanguageMode })
      .then((settings) => setLanguageMode(settings.languageMode))
      .finally(() => setIsUpdating(false))
  }

  return (
    <section
      aria-labelledby="interface-language-heading"
      className="w-full max-w-sm rounded-lg border p-5"
    >
      <h2 id="interface-language-heading" className="text-lg font-medium">
        {t('heading')}
      </h2>
      <div role="radiogroup" aria-label={t('heading')} className="mt-4 grid gap-2">
        {languageModeOptions.map(({ value, translationKey }) => {
          const isSelected = languageMode === value

          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              disabled={languageMode === undefined || isUpdating}
              onClick={() => selectLanguageMode(value)}
              className={`text-foreground enabled:hover:bg-accent flex items-center justify-between rounded-md border px-3 py-2 text-left disabled:cursor-wait disabled:opacity-60 ${
                isSelected ? 'border-primary bg-accent ring-primary/30 ring-2' : 'border-input'
              }`}
            >
              {t(translationKey)}
              {isSelected ? <span aria-hidden="true">✓</span> : null}
            </button>
          )
        })}
      </div>
    </section>
  )
}
