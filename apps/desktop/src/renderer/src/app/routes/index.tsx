import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { AppShell } from '../app-shell'
import { useAuthenticationState } from '../authentication-state'

function HomeView(): React.JSX.Element {
  const { t } = useTranslation('app')
  const { t: authenticationT } = useTranslation('authentication')
  const authentication = useAuthenticationState()

  return (
    <AppShell>
      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-8">
        <h1 className="text-foreground text-2xl font-semibold">{t('heading')}</h1>
        {authentication.isSessionPersistenceUnavailable ? (
          <p role="status" className="text-muted-foreground max-w-md text-center text-sm">
            {authenticationT('sessionPersistence.unavailable')}
          </p>
        ) : null}
      </div>
    </AppShell>
  )
}

export const Route = createFileRoute('/')({
  component: HomeView
})
