import { useCallback, useMemo, useState } from 'react'
import { OrganizationOnboardingContext, type OrganizationOnboardingState } from './onboarding-state'

export function OrganizationOnboardingProvider({
  children
}: {
  readonly children: React.ReactNode
}): React.JSX.Element {
  const [isEligible, setIsEligible] = useState(false)
  const [shouldCreateOrganization, setShouldCreateOrganization] = useState(true)
  const beginOnboarding = useCallback((): void => {
    setShouldCreateOrganization(true)
    setIsEligible(true)
  }, [])
  const skipOrganizationCreation = useCallback((): void => setShouldCreateOrganization(false), [])
  const completeOnboarding = useCallback((): void => setIsEligible(false), [])
  const value = useMemo<OrganizationOnboardingState>(
    () => ({
      isEligible,
      shouldCreateOrganization,
      beginOnboarding,
      skipOrganizationCreation,
      completeOnboarding
    }),
    [
      beginOnboarding,
      completeOnboarding,
      isEligible,
      shouldCreateOrganization,
      skipOrganizationCreation
    ]
  )

  return (
    <OrganizationOnboardingContext.Provider value={value}>
      {children}
    </OrganizationOnboardingContext.Provider>
  )
}
