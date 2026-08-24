import { createFileRoute } from '@tanstack/react-router'
import { AuthenticationScreen } from '../../features/authentication'
import { useAuthenticationState } from '../authentication-state'
import { useServerConnectionState } from '../connection-state'

function AuthenticationView(): React.JSX.Element | null {
  const connection = useServerConnectionState()
  const authentication = useAuthenticationState()

  if (connection.status !== 'configured') {
    // The root route is navigating to the Connection Screen; render nothing on
    // the transient frame so the authentication screen never shows before a
    // server connection exists.
    return null
  }

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
      instanceSetup={authentication.instanceSetup}
      setupCodeRequired={authentication.setupCodeRequired}
      rememberedEmail={authentication.rememberedEmail}
      rememberEmailSelected={authentication.rememberEmailSelected}
      isRememberedEmailPersistenceUnavailable={
        authentication.isRememberedEmailPersistenceUnavailable
      }
      rememberedEmailPersistenceNoticeSurface={
        authentication.rememberedEmailPersistenceNoticeSurface
      }
      onRetryRestore={authentication.retryRestore}
      onRetrySetupProbe={authentication.retrySetupProbe}
      onRememberEmailSelectedChange={authentication.setRememberEmailSelected}
      onRememberedEmailPersistenceNoticeShown={
        authentication.consumeRememberedEmailPersistenceNotice
      }
      onDismissError={authentication.dismissError}
      onSignIn={authentication.signIn}
      onRegister={authentication.register}
      onInitialize={authentication.initialize}
      onCompletePasswordChange={authentication.completePasswordChange}
      onSignOut={authentication.signOut}
    />
  )
}

export const Route = createFileRoute('/auth')({
  component: AuthenticationView
})
