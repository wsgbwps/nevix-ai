import { useEffect, useMemo } from 'react'
import { createRootRoute, Outlet, useLocation, useRouter } from '@tanstack/react-router'
import { useAuthenticationState } from '../authentication-state'
import { useServerConnectionState } from '../connection-state'
import { resolveStartupSurface } from '../startup-surface'

function RootView(): React.JSX.Element {
  const router = useRouter()
  const location = useLocation()
  const { status: connectionStatus } = useServerConnectionState()
  const { status: authenticationStatus } = useAuthenticationState()
  const startupSurface = useMemo(
    () =>
      resolveStartupSurface({
        connectionStatus,
        authenticationStatus,
        pathname: location.pathname
      }),
    [connectionStatus, authenticationStatus, location.pathname]
  )

  useEffect(() => {
    if ('navigate' in startupSurface) {
      void router.navigate({ to: startupSurface.navigate })
    }
  }, [router, startupSurface])

  return <Outlet />
}

export const Route = createRootRoute({
  component: RootView
})
