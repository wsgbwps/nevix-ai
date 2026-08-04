import { useEffect } from 'react'
import { createRootRoute, Outlet, useRouter } from '@tanstack/react-router'
import { useAuthenticationState } from '../authentication-state'

function RootView(): React.JSX.Element {
  const router = useRouter()
  const { status } = useAuthenticationState()

  useEffect(() => {
    void router.navigate({ to: status === 'authenticated' ? '/' : '/auth' })
  }, [router, status])

  return <Outlet />
}

export const Route = createRootRoute({
  component: RootView
})
