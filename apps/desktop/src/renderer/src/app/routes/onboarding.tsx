import { useEffect } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { OnboardingPage, useOrganizationOnboarding } from '../../features/organization'
import { saveProfile } from '../../features/profile'
import { useAuthenticationState } from '../authentication-state'

function OnboardingView(): React.JSX.Element | null {
  const authentication = useAuthenticationState()
  const onboarding = useOrganizationOnboarding()
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
      onComplete={() => {
        onboarding.completeOnboarding()
        void navigate({ to: '/', replace: true })
      }}
    />
  )
}

export const Route = createFileRoute('/onboarding')({
  component: OnboardingView
})
