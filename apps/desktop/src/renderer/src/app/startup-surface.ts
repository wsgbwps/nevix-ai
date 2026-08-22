import type { AuthenticationStatus } from '../features/authentication'

export const STARTUP_ROUTES = {
  authentication: '/auth',
  home: '/'
} as const

export interface StartupSurfaceInput {
  readonly status: AuthenticationStatus
  readonly pathname: string
}

export type StartupSurfaceDecision =
  | { readonly navigate: (typeof STARTUP_ROUTES)[keyof typeof STARTUP_ROUTES] }
  | { readonly render: 'outlet' }

/**
 * The whole pre-business decision: every status but `authenticated` — including the
 * forced first-login password change — belongs on the authentication surface, and an
 * authenticated session never stays there.
 */
export function resolveStartupSurface({
  status,
  pathname
}: StartupSurfaceInput): StartupSurfaceDecision {
  if (status !== 'authenticated') {
    return pathname === STARTUP_ROUTES.authentication
      ? { render: 'outlet' }
      : { navigate: STARTUP_ROUTES.authentication }
  }

  if (pathname === STARTUP_ROUTES.authentication) {
    return { navigate: STARTUP_ROUTES.home }
  }

  return { render: 'outlet' }
}
