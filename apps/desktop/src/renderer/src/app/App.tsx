import { useTranslation } from 'react-i18next'
import { AuthenticationScreen, useAuthentication } from '../features/authentication'
import { LanguageModeSettings } from '../features/settings'

function App(): React.JSX.Element {
  const { t } = useTranslation('app')
  const { t: authenticationT } = useTranslation('authentication')
  const authentication = useAuthentication()

  if (authentication.status !== 'authenticated') {
    return (
      <AuthenticationScreen
        status={authentication.status}
        flow={authentication.flow}
        error={authentication.error}
        notice={authentication.notice}
        isSubmitting={authentication.isSubmitting}
        resendSecondsRemaining={authentication.resendSecondsRemaining}
        resendGeneration={authentication.resendGeneration}
        didResend={authentication.didResend}
        onRetryRestore={authentication.retryRestore}
        onShowLogin={authentication.showLogin}
        onShowSignUp={authentication.showSignUp}
        onShowRecovery={authentication.showRecovery}
        onSignIn={authentication.signIn}
        onSignUp={authentication.signUp}
        onVerifySignUp={authentication.verifySignUp}
        onResendSignUp={authentication.resendSignUp}
        onRequestRecovery={authentication.requestRecovery}
        onVerifyRecovery={authentication.verifyRecovery}
        onCompleteRecovery={authentication.completeRecovery}
        secondaryContent={
          authentication.status === 'unauthenticated' ? <LanguageModeSettings /> : undefined
        }
      />
    )
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

export default App
