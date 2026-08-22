import { useEffect, useMemo } from 'react'
import { createRootRoute, Outlet, useLocation, useRouter } from '@tanstack/react-router'
import { useAuthenticationState } from '../authentication-state'
import { resolveStartupSurface } from '../startup-surface'

function RootView(): React.JSX.Element {
  const router = useRouter()
  const location = useLocation()
  const { status } = useAuthenticationState()
  const startupSurface = useMemo(
    () => resolveStartupSurface({ status, pathname: location.pathname }),
    [status, location.pathname]
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
