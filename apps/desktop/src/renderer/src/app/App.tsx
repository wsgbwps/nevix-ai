import { useEffect, useMemo } from 'react'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { useAuthentication } from '../features/authentication'
import {
  ActiveOrganizationProvider,
  OrganizationOnboardingProvider,
  SessionAccessLostDialog,
  useOrganizationOnboarding
} from '../features/organization'
import { hasCompletedProfile } from '../features/profile'
import { AuthenticationStateContext, useAuthenticationState } from './authentication-state'
import { OrdinaryCloseProvider } from './ordinary-close'
import { coordinateSettingsBack } from './pages/settings-back-navigation'
import { SettingsBackNavigationContext } from './pages/settings-coordinator'
import { routeTree } from './routeTree.gen'

function App(): React.JSX.Element {
  const authentication = useAuthentication()
  // Memory history only: the renderer ships behind file:// where the address bar is invisible,
  // so URL synchronization has no value (apps/desktop/docs/adr/0004-renderer-routing-topology.md).
  // The app always boots unauthenticated (status starts as restoring), so the initial entry is
  // the authentication view.
  const settingsNavigation = useMemo(() => {
    const history = createMemoryHistory({ initialEntries: ['/auth'] })
    return { history, back: coordinateSettingsBack(history) }
  }, [])
  const router = useMemo(
    () => createRouter({ routeTree, history: settingsNavigation.history }),
    [settingsNavigation.history]
  )

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
            <ResetOnboardingAfterAuthenticationEnds />
            <SessionAccessLostDialog />
            <SettingsBackNavigationContext.Provider value={settingsNavigation.back}>
              <RouterProvider router={router} />
            </SettingsBackNavigationContext.Provider>
          </ActiveOrganizationProvider>
        </OrganizationOnboardingProvider>
      </AuthenticationStateContext.Provider>
    </OrdinaryCloseProvider>
  )
}

function ResetOnboardingAfterAuthenticationEnds(): null {
  const { status } = useAuthenticationState()
  const onboarding = useOrganizationOnboarding()

  useEffect(() => {
    if (status !== 'authenticated' && onboarding.isEligible) {
      onboarding.completeOnboarding()
    }
  }, [onboarding, status])

  return null
}

export default App
