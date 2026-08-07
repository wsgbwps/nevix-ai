import { createFileRoute } from '@tanstack/react-router'
import { AuthenticationScreen } from '../../features/authentication'
import { useOrganizationOnboarding } from '../../features/organization'
import { useAuthenticationState } from '../authentication-state'

function AuthenticationView(): React.JSX.Element | null {
  const authentication = useAuthenticationState()
  const onboarding = useOrganizationOnboarding()

  if (authentication.status === 'authenticated') {
    // The root route is already navigating to the authenticated view; render nothing on the
    // transient frame so the authentication screen never sees an authenticated status.
    return null
  }

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
      onVerifySignUp={async (code) => {
        if (await authentication.verifySignUp(code)) onboarding.beginOnboarding()
      }}
      onResendSignUp={authentication.resendSignUp}
      onRequestRecovery={authentication.requestRecovery}
      onVerifyRecovery={authentication.verifyRecovery}
      onCompleteRecovery={authentication.completeRecovery}
    />
  )
}

export const Route = createFileRoute('/auth')({
  component: AuthenticationView
})
