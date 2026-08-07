import { useEffect } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { OrganizationPickerPage, useActiveOrganization } from '../../features/organization'
import { useAuthenticationState } from '../authentication-state'

function SelectOrganizationView(): React.JSX.Element | null {
  const authentication = useAuthenticationState()
  const organization = useActiveOrganization()
  const navigate = useNavigate()

  useEffect(() => {
    // The root route routes signed-out Users to the authentication view and entered Users away
    // from the picker; this covers the transient frames in between.
    if (authentication.status !== 'authenticated' || organization.activeOrganization) {
      void navigate({ to: '/', replace: true })
    }
  }, [authentication.status, navigate, organization.activeOrganization])

  if (authentication.status !== 'authenticated') return null

  return (
    <OrganizationPickerPage
      userEmail={authentication.userEmail}
      isSigningOut={authentication.isSubmitting}
      onSignOut={() => void authentication.signOut()}
    />
  )
}

export const Route = createFileRoute('/select-organization')({
  component: SelectOrganizationView
})
