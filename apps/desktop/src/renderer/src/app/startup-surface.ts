import type { ServerConnectionStatus } from '../features/connection'
import type { AuthenticationStatus } from '../features/authentication'

export const STARTUP_ROUTES = {
  connection: '/connect',
  authentication: '/auth',
  home: '/'
} as const

export interface StartupSurfaceInput {
  readonly connectionStatus: ServerConnectionStatus
  readonly authenticationStatus: AuthenticationStatus
  readonly pathname: string
}

export type StartupSurfaceDecision =
  | { readonly navigate: (typeof STARTUP_ROUTES)[keyof typeof STARTUP_ROUTES] }
  | { readonly render: 'outlet' }

/**
 * The whole pre-business decision: a device without a configured server
 * connection belongs on the Connection Screen; once configured, every
 * authentication status but `authenticated` — including the forced first-login
 * password change — belongs on the authentication surface; an authenticated
 * session never stays on either pre-business surface.
 */
export function resolveStartupSurface({
  connectionStatus,
  authenticationStatus,
  pathname
}: StartupSurfaceInput): StartupSurfaceDecision {
  if (connectionStatus === 'unconfigured') {
    return pathname === STARTUP_ROUTES.connection
      ? { render: 'outlet' }
      : { navigate: STARTUP_ROUTES.connection }
  }

  if (authenticationStatus !== 'authenticated') {
    return pathname === STARTUP_ROUTES.authentication
      ? { render: 'outlet' }
      : { navigate: STARTUP_ROUTES.authentication }
  }

  if (pathname === STARTUP_ROUTES.authentication || pathname === STARTUP_ROUTES.connection) {
    return { navigate: STARTUP_ROUTES.home }
  }

  return { render: 'outlet' }
}
