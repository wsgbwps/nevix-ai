import { useMemo } from 'react'
import { useCurrentSession } from '../../features/authentication'
import { useServerConnection } from '../../features/connection'
import {
  CreationRuntimeContext,
  createCreationWorkspacePorts,
  CreationWorkbenchPage
} from '../../features/creation'
import { AppShell } from '../shell/app-shell'

/**
 * App-layer composition for the AI Creation route: joins the connected
 * session + server URL to the feature's runtime provider and mounts the
 * Workbench inside the App Shell content area. All business logic stays
 * inside the creation Feature.
 */
export function CreationPage(): React.JSX.Element | null {
  const session = useCurrentSession()
  const connection = useServerConnection()

  // The Workbench re-runs its initial load whenever the ports identity
  // changes, so the value must stay referentially stable across renders that
  // only churn session/connection object literals; otherwise an in-flight
  // create or selection gets clobbered back to the unselected empty state.
  const acquireSession = session.status === 'available' ? session.acquireSession : undefined
  const userId = session.status === 'available' ? session.user.id : undefined
  // userId scopes the device-local Draft store to the connected account
  // (ADR-0017); it rides the same memo so the runtime identity stays stable.
  const ports = useMemo(
    () =>
      acquireSession && userId && connection.status === 'configured' && connection.url !== undefined
        ? { ...createCreationWorkspacePorts(connection.url, acquireSession), userId }
        : null,
    [acquireSession, userId, connection.status, connection.url]
  )

  if (ports === null) {
    // The root route navigates to the matching boundary surface; render nothing here.
    return null
  }

  return (
    <CreationRuntimeContext.Provider value={ports}>
      <AppShell>
        <CreationWorkbenchPage />
      </AppShell>
    </CreationRuntimeContext.Provider>
  )
}
