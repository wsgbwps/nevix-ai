import { useMemo } from 'react'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { RememberedEmailPersistenceNotice, useAuthentication } from '../features/authentication'
import {
  ActiveOrganizationProvider,
  OrganizationOnboardingProvider,
  SessionAccessLostDialog
} from '../features/organization'
import { hasCompletedProfile } from '../features/profile'
import { AuthenticationStateContext } from './authentication-state'
import { ResetOrganizationOnboardingAfterSessionEnds } from './organization-onboarding-session-reset'
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
        <OrganizationOnboardingProvider>
          <ActiveOrganizationProvider
            // Remounting on the authentication transition resets the Organization state, so the
            // next Session never renders data the previous Session was entitled to.
            key={authentication.status === 'authenticated' ? 'authenticated' : 'signed-out'}
            isAuthenticated={authentication.status === 'authenticated'}
            getSession={authentication.getSession}
            hasCompletedProfile={hasCompletedProfile}
          >
            <ResetOrganizationOnboardingAfterSessionEnds />
            <SessionAccessLostDialog />
            <RememberedEmailPersistenceNotice
              surface="authenticated"
              isSurfaceActive={authentication.status === 'authenticated'}
              isPersistenceUnavailable={authentication.isRememberedEmailPersistenceUnavailable}
              noticeSurface={authentication.rememberedEmailPersistenceNoticeSurface}
              onShown={authentication.consumeRememberedEmailPersistenceNotice}
            />
            <RouterProvider router={router} />
          </ActiveOrganizationProvider>
        </OrganizationOnboardingProvider>
      </AuthenticationStateContext.Provider>
    </OrdinaryCloseProvider>
  )
}

export default App
