import type { AuthenticationStatus } from '../features/authentication'

export const STARTUP_ROUTES = {
  authentication: '/auth',
  onboarding: '/onboarding',
  organizationPicker: '/select-organization',
  home: '/'
} as const

export interface StartupSurfaceInput {
  readonly status: AuthenticationStatus
  readonly isEligible: boolean
  readonly phase: 'idle' | 'resolving' | 'ready'
  readonly hasActiveOrganization: boolean
  readonly pathname: string
}

export type StartupSurfaceDecision =
  | { readonly navigate: (typeof STARTUP_ROUTES)[keyof typeof STARTUP_ROUTES] }
  | { readonly render: 'restoring' | 'outlet' }

export function resolveStartupSurface({
  status,
  isEligible,
  phase,
  hasActiveOrganization,
  pathname
}: StartupSurfaceInput): StartupSurfaceDecision {
  if (status !== 'authenticated') {
    return pathname === STARTUP_ROUTES.authentication
      ? { render: 'outlet' }
      : { navigate: STARTUP_ROUTES.authentication }
  }

  if (isEligible) {
    return pathname === STARTUP_ROUTES.onboarding
      ? { render: 'outlet' }
      : { navigate: STARTUP_ROUTES.onboarding }
  }

  if (phase !== 'ready') return { render: 'restoring' }

  if (!hasActiveOrganization) {
    return pathname === STARTUP_ROUTES.organizationPicker
      ? { render: 'outlet' }
      : { navigate: STARTUP_ROUTES.organizationPicker }
  }

  if (
    pathname === STARTUP_ROUTES.authentication ||
    pathname === STARTUP_ROUTES.organizationPicker
  ) {
    return { navigate: STARTUP_ROUTES.home }
  }

  return { render: 'outlet' }
}
