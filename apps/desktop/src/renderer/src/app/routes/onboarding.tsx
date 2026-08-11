import { useEffect } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  OnboardingPage,
  useActiveOrganization,
  useOrganizationOnboarding,
  type OnboardingCompletedOrganization
} from '../../features/organization'
import { saveProfile } from '../../features/profile'
import { useAuthenticationState } from '../authentication-state'

function OnboardingView(): React.JSX.Element | null {
  const authentication = useAuthenticationState()
  const onboarding = useOrganizationOnboarding()
  const activeOrganization = useActiveOrganization()
  const navigate = useNavigate()
  const canShowOnboarding = authentication.status === 'authenticated' && onboarding.isEligible

  useEffect(() => {
    if (authentication.status === 'authenticated' && !onboarding.isEligible) {
      void navigate({ to: '/', replace: true })
    }
  }, [authentication.status, navigate, onboarding.isEligible])

  if (!canShowOnboarding) return null

  return (
    <OnboardingPage
      getSession={authentication.getSession}
      saveDisplayName={saveProfile}
      shouldCreateOrganization={onboarding.shouldCreateOrganization}
      onProfileComplete={() => {
        onboarding.completeOnboarding()
        void navigate({ to: '/select-organization', replace: true })
      }}
      onComplete={(organization: OnboardingCompletedOrganization) => {
        // The creator becomes the first Owner; entering also remembers the Organization on this
        // device before the landing navigation runs.
        activeOrganization.enterOrganization({
          organizationId: organization.id,
          organizationName: organization.name,
          role: 'owner'
        })
        onboarding.completeOnboarding()
        void navigate({ to: '/', replace: true })
      }}
    />
  )
}

export const Route = createFileRoute('/onboarding')({
  component: OnboardingView
})
