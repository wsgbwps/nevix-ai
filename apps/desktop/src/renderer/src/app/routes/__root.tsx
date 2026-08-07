import { useEffect } from 'react'
import { createRootRoute, Outlet, useLocation, useRouter } from '@tanstack/react-router'
import {
  StartupRestoringView,
  useActiveOrganization,
  useOrganizationOnboarding
} from '../../features/organization'
import { useAuthenticationState } from '../authentication-state'

function RootView(): React.JSX.Element {
  const router = useRouter()
  const location = useLocation()
  const { status } = useAuthenticationState()
  const { isEligible } = useOrganizationOnboarding()
  const organization = useActiveOrganization()

  useEffect(() => {
    if (status !== 'authenticated') {
      void router.navigate({ to: '/auth' })
      return
    }

    // Onboarding owns the screen for as long as it is eligible, so this branch must return
    // instead of falling through to the Organization branches below.
    if (isEligible) {
      if (location.pathname !== '/onboarding') {
        void router.navigate({ to: '/onboarding' })
      }
      return
    }

    // The startup verification has not taken a branch yet; the restoring view renders instead.
    if (organization.startupPhase !== 'ready') return

    if (!organization.activeOrganization) {
      // Zero Organizations already begins onboarding above, so here at least one Membership
      // exists and the User must pick one (multiple Organizations, or a stale device memory).
      if (location.pathname !== '/select-organization') {
        void router.navigate({ to: '/select-organization' })
      }
      return
    }

    if (location.pathname === '/auth' || location.pathname === '/select-organization') {
      void router.navigate({ to: '/' })
    }
  }, [isEligible, location.pathname, organization, router, status])

  const isRestoringOrganizationContext =
    status === 'authenticated' && !isEligible && organization.startupPhase !== 'ready'

  return isRestoringOrganizationContext ? <StartupRestoringView /> : <Outlet />
}

export const Route = createRootRoute({
  component: RootView
})
