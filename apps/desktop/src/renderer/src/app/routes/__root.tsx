import { useEffect, useMemo } from 'react'
import { createRootRoute, Outlet, useLocation, useRouter } from '@tanstack/react-router'
import { useCurrentSession } from '../../features/authentication'
import { useServerConnectionState } from '../connection-state'
import { resolveStartupSurface } from '../startup-surface'

function RootView(): React.JSX.Element {
  const router = useRouter()
  const location = useLocation()
  const { status: connectionStatus } = useServerConnectionState()
  const session = useCurrentSession()
  const startupSurface = useMemo(
    () =>
      resolveStartupSurface({
        connectionStatus,
        sessionAvailable: session.status === 'available',
        pathname: location.pathname
      }),
    [connectionStatus, session, location.pathname]
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
