import { createFileRoute } from '@tanstack/react-router'
import { AuthenticationSurface } from '../../features/authentication'
import { useServerConnectionState } from '../connection-state'

function AuthenticationView(): React.JSX.Element | null {
  const connection = useServerConnectionState()

  if (connection.status !== 'configured') {
    // The root route is navigating to the Connection Screen; render nothing on
    // the transient frame so the authentication surface never shows before a
    // server connection exists.
    return null
  }

  // Zero props: the whole pre-authentication workflow is owned by the
  // Authentication runtime; this route only places the owned surface.
  return <AuthenticationSurface />
}

export const Route = createFileRoute('/auth')({
  component: AuthenticationView
})
