import { useEffect, useRef } from 'react'
import { createRootRoute, Outlet, useLocation, useRouter } from '@tanstack/react-router'
import { useOrganizationOnboarding } from '../../features/organization'
import { useAuthenticationState } from '../authentication-state'

function RootView(): React.JSX.Element {
  const router = useRouter()
  const location = useLocation()
  const { status } = useAuthenticationState()
  const { isEligible } = useOrganizationOnboarding()
  const didRedirectOnboarding = useRef(false)

  useEffect(() => {
    if (status !== 'authenticated') {
      didRedirectOnboarding.current = false
      void router.navigate({ to: '/auth' })
      return
    }

    if (isEligible && !didRedirectOnboarding.current) {
      didRedirectOnboarding.current = true
      void router.navigate({ to: '/onboarding' })
      return
    }

    if (location.pathname === '/auth') {
      void router.navigate({ to: '/' })
    }
  }, [isEligible, location.pathname, router, status])

  return <Outlet />
}

export const Route = createRootRoute({
  component: RootView
})
