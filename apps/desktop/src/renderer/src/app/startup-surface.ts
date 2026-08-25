import type { ServerConnectionStatus } from '../features/connection'

export const STARTUP_ROUTES = {
  connection: '/connect',
  authentication: '/auth',
  home: '/'
} as const

export interface StartupSurfaceInput {
  readonly connectionStatus: ServerConnectionStatus
  /** Coarse current-session availability: every pre-authentication state counts as unavailable. */
  readonly sessionAvailable: boolean
  readonly pathname: string
}

export type StartupSurfaceDecision =
  | { readonly navigate: (typeof STARTUP_ROUTES)[keyof typeof STARTUP_ROUTES] }
  | { readonly render: 'outlet' }

/**
 * The whole pre-business decision: a device without a configured server
 * connection belongs on the Connection Screen; once configured, every
 * pre-authenticated state — including the forced first-login password change,
 * which the current-session reader reports as unavailable — belongs on the
 * authentication surface; an available session never stays on either
 * pre-business surface.
 */
export function resolveStartupSurface({
  connectionStatus,
  sessionAvailable,
  pathname
}: StartupSurfaceInput): StartupSurfaceDecision {
  if (connectionStatus === 'unconfigured') {
    return pathname === STARTUP_ROUTES.connection
      ? { render: 'outlet' }
      : { navigate: STARTUP_ROUTES.connection }
  }

  if (!sessionAvailable) {
    return pathname === STARTUP_ROUTES.authentication
      ? { render: 'outlet' }
      : { navigate: STARTUP_ROUTES.authentication }
  }

  if (pathname === STARTUP_ROUTES.authentication || pathname === STARTUP_ROUTES.connection) {
    return { navigate: STARTUP_ROUTES.home }
  }

  return { render: 'outlet' }
}
