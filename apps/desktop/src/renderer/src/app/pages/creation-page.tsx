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

  if (session.status !== 'available' || connection.status !== 'configured') {
    // The root route navigates to the matching boundary surface; render nothing here.
    return null
  }

  return (
    <CreationRuntimeContext.Provider
      value={createCreationWorkspacePorts(connection.url ?? '', session.acquireSession)}
    >
      <div className="h-full min-h-0 overflow-hidden">
        <CreationWorkbenchPage />
      </div>
    </CreationRuntimeContext.Provider>
  )
}
