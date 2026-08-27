import { useMemo } from 'react'
import { useCurrentSession } from '../../features/authentication'
import { useServerConnection } from '../../features/connection'
import {
  CreationRuntimeContext,
  createCreationWorkspacePorts,
  CreationWorkbenchPage
} from '../../features/creation'

/**
 * App-layer composition for the AI Creation route: joins the connected
 * session + server URL to the feature's runtime provider. All business logic
 * stays inside the creation Feature.
 */
export function CreationPage(): React.JSX.Element | null {
  const session = useCurrentSession()
  const connection = useServerConnection()

  // The Workbench re-runs its initial load whenever the ports identity
  // changes, so the value must stay referentially stable across renders that
  // only churn session/connection object literals; otherwise an in-flight
  // create or selection gets clobbered back to the unselected empty state.
  const acquireSession = session.status === 'available' ? session.acquireSession : undefined
  const ports = useMemo(
    () =>
      acquireSession && connection.status === 'configured' && connection.url !== undefined
        ? createCreationWorkspacePorts(connection.url, acquireSession)
        : null,
    [acquireSession, connection.status, connection.url]
  )

  if (ports === null) {
    // The root route navigates to the matching boundary surface; render nothing here.
    return null
  }

  return (
    <CreationRuntimeContext.Provider value={ports}>
      <div className="h-full min-h-0 overflow-hidden">
        <CreationWorkbenchPage />
      </div>
    </CreationRuntimeContext.Provider>
  )
}
