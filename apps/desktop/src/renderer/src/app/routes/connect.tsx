import { createFileRoute } from '@tanstack/react-router'
import { ConnectionScreen } from '../../features/connection'
import { useServerConnectionState } from '../connection-state'

function ConnectionView(): React.JSX.Element | null {
  const connection = useServerConnectionState()

  if (connection.status !== 'unconfigured') {
    // The root route is already navigating away; render nothing on the
    // transient frame so the Connection Screen never shows once configured.
    return null
  }

  return <ConnectionScreen />
}

export const Route = createFileRoute('/connect')({
  component: ConnectionView
})
