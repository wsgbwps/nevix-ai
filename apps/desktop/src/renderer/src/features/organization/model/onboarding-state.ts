import { createContext, useContext } from 'react'

export interface OrganizationOnboardingState {
  readonly isEligible: boolean
  readonly shouldCreateOrganization: boolean
  readonly beginOnboarding: () => void
  readonly skipOrganizationCreation: () => void
  readonly completeOnboarding: () => void
}

export const OrganizationOnboardingContext = createContext<OrganizationOnboardingState | null>(null)

export function useOrganizationOnboarding(): OrganizationOnboardingState {
  const state = useContext(OrganizationOnboardingContext)
  if (state === null) {
    throw new Error('Organization onboarding state must be provided by the Organization Feature.')
  }
  return state
}
