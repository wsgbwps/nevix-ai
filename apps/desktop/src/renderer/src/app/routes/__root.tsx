import { useEffect, useMemo } from 'react'
import { createRootRoute, Outlet, useLocation, useRouter } from '@tanstack/react-router'
import {
  StartupFailureView,
  StartupRestoringView,
  useActiveOrganization,
  useOrganizationOnboarding
} from '../../features/organization'
import { useAuthenticationState } from '../authentication-state'
import { resolveStartupSurface } from '../startup-surface'

function RootView(): React.JSX.Element {
  const router = useRouter()
  const location = useLocation()
  const { status } = useAuthenticationState()
  const { isEligible } = useOrganizationOnboarding()
  const organization = useActiveOrganization()
  const hasActiveOrganization = organization.activeOrganization !== undefined
  const startupSurface = useMemo(
    () =>
      resolveStartupSurface({
        status,
        isEligible,
        phase: organization.startupPhase,
        hasActiveOrganization,
        pathname: location.pathname
      }),
    [status, isEligible, organization.startupPhase, hasActiveOrganization, location.pathname]
  )

  useEffect(() => {
    if ('navigate' in startupSurface) {
      void router.navigate({ to: startupSurface.navigate })
    }
  }, [router, startupSurface])

  if ('render' in startupSurface && startupSurface.render === 'restoring') {
    return <StartupRestoringView />
  }
  if ('render' in startupSurface && startupSurface.render === 'startup-failure') {
    return <StartupFailureView onRetry={organization.retryStartup} />
  }
  return <Outlet />
}

export const Route = createRootRoute({
  component: RootView
})
