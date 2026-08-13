import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'

export function StartupFailureView({
  onRetry
}: {
  readonly onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation('organization')

  return (
    <main className="bg-muted/30 flex min-h-svh items-center justify-center px-6 py-10">
      <div className="text-center">
        <h1 className="text-2xl font-bold">{t('startup.failureHeading')}</h1>
        <p className="text-muted-foreground mt-2 text-sm">{t('startup.failureDescription')}</p>
        <Button className="mt-6" type="button" onClick={onRetry}>
          {t('startup.retry')}
        </Button>
      </div>
    </main>
  )
}
