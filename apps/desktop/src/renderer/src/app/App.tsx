import { useTranslation } from 'react-i18next'
import { LanguageModeSettings } from '../features/settings'

function App(): React.JSX.Element {
  const { t } = useTranslation('app')

  return (
    <div className="bg-background flex h-screen flex-col items-center justify-center gap-8 px-6">
      <h1 className="text-foreground text-2xl font-semibold">{t('heading')}</h1>
      <LanguageModeSettings />
    </div>
  )
}

export default App
