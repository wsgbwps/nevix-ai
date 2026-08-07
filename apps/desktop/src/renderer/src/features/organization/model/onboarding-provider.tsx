import { useCallback, useMemo, useState } from 'react'
import { OrganizationOnboardingContext, type OrganizationOnboardingState } from './onboarding-state'

export function OrganizationOnboardingProvider({
  children
}: {
  readonly children: React.ReactNode
}): React.JSX.Element {
  const [isEligible, setIsEligible] = useState(false)
  const beginOnboarding = useCallback((): void => setIsEligible(true), [])
  const completeOnboarding = useCallback((): void => setIsEligible(false), [])
  const value = useMemo<OrganizationOnboardingState>(
    () => ({ isEligible, beginOnboarding, completeOnboarding }),
    [beginOnboarding, completeOnboarding, isEligible]
  )

  return (
    <OrganizationOnboardingContext.Provider value={value}>
      {children}
    </OrganizationOnboardingContext.Provider>
  )
}
