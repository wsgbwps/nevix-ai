import { createFileRoute } from '@tanstack/react-router'
import { AuthenticationScreen } from '../../features/authentication'
import { useAuthenticationState } from '../authentication-state'

function AuthenticationView(): React.JSX.Element | null {
  const authentication = useAuthenticationState()

  if (authentication.status === 'authenticated') {
    // The root route is already navigating to the authenticated view; render nothing on the
    // transient frame so the authentication screen never sees an authenticated status.
    return null
  }

  return (
    <AuthenticationScreen
      status={authentication.status}
      error={authentication.error}
      notice={authentication.notice}
      isSubmitting={authentication.isSubmitting}
      rememberedEmail={authentication.rememberedEmail}
      rememberEmailSelected={authentication.rememberEmailSelected}
      isRememberedEmailPersistenceUnavailable={
        authentication.isRememberedEmailPersistenceUnavailable
      }
      rememberedEmailPersistenceNoticeSurface={
        authentication.rememberedEmailPersistenceNoticeSurface
      }
      onRetryRestore={authentication.retryRestore}
      onRememberEmailSelectedChange={authentication.setRememberEmailSelected}
      onRememberedEmailPersistenceNoticeShown={
        authentication.consumeRememberedEmailPersistenceNotice
      }
      onSignIn={authentication.signIn}
      onCompletePasswordChange={authentication.completePasswordChange}
      onSignOut={authentication.signOut}
    />
  )
}

export const Route = createFileRoute('/auth')({
  component: AuthenticationView
})
