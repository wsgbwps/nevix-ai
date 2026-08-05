import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LANGUAGE_MODES, type LanguageMode } from '../../../../../shared/i18n/language-mode'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../../../components/ui/select'

const languageModeTranslationKeys = {
  'follow-system': 'followSystem',
  'zh-CN': 'zhCN',
  en: 'en'
} as const satisfies Record<LanguageMode, string>

export function LanguageModeSettings(): React.JSX.Element {
  const { t } = useTranslation('language')
  const [languageMode, setLanguageMode] = useState<LanguageMode | undefined>()
  const [isUpdating, setIsUpdating] = useState(false)

  useEffect(() => {
    let isMounted = true
    const unsubscribe = window.api.on('language:language-mode-changed', (state) => {
      if (isMounted) setLanguageMode(state.languageMode)
    })

    void window.api.invoke('language:get-language-mode').then((state) => {
      if (isMounted) setLanguageMode(state.languageMode)
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
      .invoke('language:set-language-mode', { languageMode: nextLanguageMode })
      .then((state) => setLanguageMode(state.languageMode))
      .finally(() => setIsUpdating(false))
  }

  return (
    <section aria-labelledby="interface-language-heading" className="w-full rounded-lg border p-5">
      <h2 id="interface-language-heading" className="text-lg font-medium">
        {t('heading')}
      </h2>
      <Select
        value={languageMode}
        onValueChange={(value) => selectLanguageMode(value as LanguageMode)}
        disabled={languageMode === undefined || isUpdating}
      >
        <SelectTrigger aria-label={t('heading')} className="mt-4 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LANGUAGE_MODES.map((value) => (
            <SelectItem key={value} value={value}>
              {t(languageModeTranslationKeys[value])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </section>
  )
}
