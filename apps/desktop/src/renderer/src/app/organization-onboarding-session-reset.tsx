import { useEffect } from 'react'
import { useOrganizationOnboarding } from '../features/organization'
import { useAuthenticationState } from './authentication-state'

// The OrganizationOnboardingProvider sits outside the keyed ActiveOrganizationProvider remount
// boundary so the sign-up handoff (`beginOnboarding` in the auth route) survives the
// authentication transition. The price is that onboarding eligibility also survives Session
// changes, so it must be reset when a Session ends — otherwise the previous Session's
// eligibility leaks into the next Session's startup window before startup resolution
// re-derives it from Profile and Membership facts.
export function ResetOrganizationOnboardingAfterSessionEnds(): null {
  const { status } = useAuthenticationState()
  const onboarding = useOrganizationOnboarding()

  useEffect(() => {
    if (status !== 'authenticated' && onboarding.isEligible) {
      onboarding.resetOnboarding()
    }
  }, [onboarding, status])

  return null
}
