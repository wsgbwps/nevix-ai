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
    <div className="flex items-center justify-between gap-6 px-5 py-4">
      <div className="grid gap-0.5">
        <p className="text-sm font-medium">{t('heading')}</p>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </div>
      <Select
        value={languageMode}
        onValueChange={(value) => selectLanguageMode(value as LanguageMode)}
        disabled={languageMode === undefined || isUpdating}
      >
        <SelectTrigger aria-label={t('heading')} className="w-44">
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
    </div>
  )
}
