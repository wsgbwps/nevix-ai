import { useMemo } from 'react'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { useAuthentication } from '../features/authentication'
import { AuthenticationStateContext } from './authentication-state'
import { routeTree } from './routeTree.gen'

function App(): React.JSX.Element {
  const authentication = useAuthentication()
  // Memory history only: the renderer ships behind file:// where the address bar is invisible,
  // so URL synchronization has no value (apps/desktop/docs/adr/0004-renderer-routing-topology.md).
  // The app always boots unauthenticated (status starts as restoring), so the initial entry is
  // the authentication view.
  const router = useMemo(
    () => createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/auth'] }) }),
    []
  )

  return (
    <AuthenticationStateContext.Provider value={authentication}>
      <RouterProvider router={router} />
    </AuthenticationStateContext.Provider>
  )
}

export default App
