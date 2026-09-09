import { useEffect, useMemo, useRef } from 'react'
import { Outlet, useLocation, useRouter } from '@tanstack/react-router'
import { useCurrentSession, useInstanceClaimAcquisition } from '../features/authentication'
import { useServerConnectionState } from './connection-state'
import { resolveStartupSurface } from './startup-surface'

/** Coordinates pre-business routing and consumes the one-shot claim handoff. */
export function StartupCoordinator(): React.JSX.Element {
  const router = useRouter()
  const location = useLocation()
  const { status: connectionStatus } = useServerConnectionState()
  const session = useCurrentSession()
  const { pending: instanceClaimAcquired, consume: consumeInstanceClaimAcquisition } =
    useInstanceClaimAcquisition()
  const claimNavigationInFlight = useRef(false)
  const startupSurface = useMemo(
    () =>
      resolveStartupSurface({
        connectionStatus,
        sessionAvailable: session.status === 'available',
        pathname: location.pathname,
        instanceClaimAcquired
      }),
    [connectionStatus, instanceClaimAcquired, session, location.pathname]
  )

  useEffect(() => {
    if (!('navigate' in startupSurface)) return
    if (startupSurface.settingsSection !== 'aiCreation') {
      void router.navigate({ to: startupSurface.navigate })
      return
    }
    if (claimNavigationInFlight.current) return

    claimNavigationInFlight.current = true
    void router
      .navigate({
        to: '/settings',
        replace: true,
        state: (state) => ({ ...state, settings: { section: 'aiCreation' } })
      })
      .then(consumeInstanceClaimAcquisition, () => {
        claimNavigationInFlight.current = false
      })
  }, [consumeInstanceClaimAcquisition, router, startupSurface])

  return <Outlet />
}
