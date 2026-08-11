import { useCallback, useMemo, useState } from 'react'
import { OrganizationOnboardingContext, type OrganizationOnboardingState } from './onboarding-state'

export function OrganizationOnboardingProvider({
  children
}: {
  readonly children: React.ReactNode
}): React.JSX.Element {
  const [shouldCompleteProfile, setShouldCompleteProfile] = useState(false)
  const [shouldCreateOrganization, setShouldCreateOrganization] = useState(false)
  const beginOnboarding = useCallback((): void => {
    setShouldCreateOrganization(true)
  }, [])
  const resolveOnboarding = useCallback(
    (requirements: {
      readonly shouldCompleteProfile: boolean
      readonly shouldCreateOrganization: boolean
    }): void => {
      setShouldCompleteProfile(requirements.shouldCompleteProfile)
      setShouldCreateOrganization(requirements.shouldCreateOrganization)
    },
    []
  )
  const completeProfile = useCallback((): void => setShouldCompleteProfile(false), [])
  const completeOnboarding = useCallback((): void => {
    setShouldCompleteProfile(false)
    setShouldCreateOrganization(false)
  }, [])
  const isEligible = shouldCompleteProfile || shouldCreateOrganization
  const value = useMemo<OrganizationOnboardingState>(
    () => ({
      isEligible,
      shouldCompleteProfile,
      shouldCreateOrganization,
      beginOnboarding,
      resolveOnboarding,
      completeProfile,
      completeOnboarding
    }),
    [
      beginOnboarding,
      completeProfile,
      completeOnboarding,
      isEligible,
      resolveOnboarding,
      shouldCompleteProfile,
      shouldCreateOrganization
    ]
  )

  return (
    <OrganizationOnboardingContext.Provider value={value}>
      {children}
    </OrganizationOnboardingContext.Provider>
  )
}
