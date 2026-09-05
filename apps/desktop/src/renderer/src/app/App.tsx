import { useMemo, type ReactNode } from 'react'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { AuthenticationProvider, useCurrentSession } from '../features/authentication'
import { useServerConnection } from '../features/connection'
import { CreationRuntimeProvider } from '../features/creation'
import { ServerConnectionStateContext } from './connection-state'
import { OrdinaryCloseProvider } from './ordinary-close'
import { routeTree } from './routeTree.gen'

function App(): React.JSX.Element {
  const connection = useServerConnection()
  // Memory history only: the renderer ships behind file:// where the address bar is invisible,
  // so URL synchronization has no value (apps/desktop/docs/adr/0004-renderer-routing-topology.md).
  // The app always boots before any session exists, so the initial entry is the
  // authentication view.
  const history = useMemo(() => createMemoryHistory({ initialEntries: ['/auth'] }), [])
  const router = useMemo(() => createRouter({ routeTree, history }), [history])

  return (
    <OrdinaryCloseProvider>
      <ServerConnectionStateContext.Provider value={connection}>
        {/* The one renderer-document Authentication runtime: dormant until a
            server URL exists, then permanently bound to it. App pages consume
            only the current-session reader; the owned surface and notices live
            inside the Feature. */}
        <AuthenticationProvider serverUrl={connection.url}>
          <CreationRuntimeComposition serverUrl={connection.url}>
            <RouterProvider router={router} />
          </CreationRuntimeComposition>
        </AuthenticationProvider>
      </ServerConnectionStateContext.Provider>
    </OrdinaryCloseProvider>
  )
}

function CreationRuntimeComposition({
  children,
  serverUrl
}: {
  readonly children: ReactNode
  readonly serverUrl: string | undefined
}): React.JSX.Element {
  const session = useCurrentSession()
  const acquireSession =
    session.status === 'available' && !session.isSigningOut ? session.acquireSession : undefined
  const userId =
    session.status === 'available' && !session.isSigningOut ? session.user.id : undefined

  return (
    <CreationRuntimeProvider acquireSession={acquireSession} serverUrl={serverUrl} userId={userId}>
      {children}
    </CreationRuntimeProvider>
  )
}

export default App
