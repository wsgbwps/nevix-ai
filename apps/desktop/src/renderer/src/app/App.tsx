import { useTranslation } from 'react-i18next'

function App(): React.JSX.Element {
  const { t } = useTranslation('app')

  return (
    <div className="bg-background flex h-screen items-center justify-center">
      <h1 className="text-foreground text-2xl font-semibold">{t('heading')}</h1>
    </div>
  )
}

export default App
