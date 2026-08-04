import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { LanguageModeSettings } from '../../features/language'
import { useAuthenticationState } from '../authentication-state'

function AuthenticatedView(): React.JSX.Element | null {
  const { t } = useTranslation('app')
  const { t: authenticationT } = useTranslation('authentication')
  const authentication = useAuthenticationState()

  if (authentication.status !== 'authenticated') {
    // The root route is already navigating to the authentication view; render nothing on the
    // transient frame so the authenticated placeholder never shows for a signed-out user.
    return null
  }

  return (
    <div className="bg-background flex h-screen flex-col items-center justify-center gap-8 px-6">
      <h1 className="text-foreground text-2xl font-semibold">{t('heading')}</h1>
      {authentication.isSessionPersistenceUnavailable ? (
        <p role="status" className="text-muted-foreground max-w-md text-center text-sm">
          {authenticationT('sessionPersistence.unavailable')}
        </p>
      ) : null}
      <LanguageModeSettings />
      <button
        type="button"
        disabled={authentication.isSubmitting}
        onClick={() => void authentication.signOut()}
        className="border-input hover:bg-accent rounded-md border px-4 py-2 text-sm font-medium disabled:cursor-wait disabled:opacity-60"
      >
        {authenticationT(authentication.isSubmitting ? 'logout.submitting' : 'logout.submit')}
      </button>
    </div>
  )
}

export const Route = createFileRoute('/')({
  component: AuthenticatedView
})
