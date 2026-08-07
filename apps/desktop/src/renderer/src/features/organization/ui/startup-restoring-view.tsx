import { useTranslation } from 'react-i18next'

/** Shown while the startup verification reads Memberships and device memory. */
export function StartupRestoringView(): React.JSX.Element {
  const { t } = useTranslation('organization')

  return (
    <main className="bg-muted/30 flex min-h-svh items-center justify-center px-6 py-10">
      <p className="text-muted-foreground text-sm" role="status">
        {t('startup.restoring')}
      </p>
    </main>
  )
}
