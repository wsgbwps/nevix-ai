import { useMemo } from 'react'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { RememberedEmailPersistenceNotice, useAuthentication } from '../features/authentication'
import { AuthenticationStateContext } from './authentication-state'
import { OrdinaryCloseProvider } from './ordinary-close'
import { routeTree } from './routeTree.gen'

function App(): React.JSX.Element {
  const authentication = useAuthentication()
  // Memory history only: the renderer ships behind file:// where the address bar is invisible,
  // so URL synchronization has no value (apps/desktop/docs/adr/0004-renderer-routing-topology.md).
  // The app always boots unauthenticated (status starts as restoring), so the initial entry is
  // the authentication view.
  const history = useMemo(() => createMemoryHistory({ initialEntries: ['/auth'] }), [])
  const router = useMemo(() => createRouter({ routeTree, history }), [history])

  return (
    <OrdinaryCloseProvider>
      <AuthenticationStateContext.Provider value={authentication}>
        <RememberedEmailPersistenceNotice
          surface="authenticated"
          isSurfaceActive={authentication.status === 'authenticated'}
          isPersistenceUnavailable={authentication.isRememberedEmailPersistenceUnavailable}
          noticeSurface={authentication.rememberedEmailPersistenceNoticeSurface}
          onShown={authentication.consumeRememberedEmailPersistenceNotice}
        />
        <RouterProvider router={router} />
      </AuthenticationStateContext.Provider>
    </OrdinaryCloseProvider>
  )
}

export default App
