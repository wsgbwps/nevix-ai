import { useTranslation } from 'react-i18next'
import { AppShell } from '../shell/app-shell'

export function HomePage(): React.JSX.Element {
  const { t } = useTranslation('app')

  return (
    <AppShell>
      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-8">
        <h1 className="text-foreground text-2xl font-semibold">{t('heading')}</h1>
      </div>
    </AppShell>
  )
}
