import {
  OnboardingPage,
  OrganizationPickerPage,
  useActiveOrganization,
  type OnboardingCompletedOrganization
} from '../../features/organization'
import { saveProfile } from '../../features/profile'
import type { SettingsOrganizationPickerEntry } from './settings-navigation'

interface SettingsOrganizationSession {
  readonly accessToken: string
  readonly userId: string
}

interface SettingsOrganizationPickerPageProps {
  readonly phase: SettingsOrganizationPickerEntry['phase']
  readonly userEmail: string | undefined
  readonly isSigningOut: boolean
  readonly getSession: () => Promise<SettingsOrganizationSession | undefined>
  readonly onCreateOrganization: () => void
  readonly onFinish: () => void
  readonly onSignOut: () => void
}

export function SettingsOrganizationPickerPage({
  phase,
  userEmail,
  isSigningOut,
  getSession,
  onCreateOrganization,
  onFinish,
  onSignOut
}: SettingsOrganizationPickerPageProps): React.JSX.Element {
  const organization = useActiveOrganization()

  if (phase === 'organization-create') {
    return (
      <OnboardingPage
        getSession={getSession}
        saveDisplayName={saveProfile}
        shouldCompleteProfile={false}
        shouldCreateOrganization
        onProfileComplete={() => undefined}
        onComplete={async (created: OnboardingCompletedOrganization) => {
          await organization.selectOrganization(created.id)
          onFinish()
        }}
      />
    )
  }

  return (
    <OrganizationPickerPage
      origin="settings"
      userEmail={userEmail}
      isSigningOut={isSigningOut}
      onCancel={async () => {
        await organization.verifyActiveMembership()
        onFinish()
      }}
      onComplete={onFinish}
      onCreateOrganization={onCreateOrganization}
      onSignOut={onSignOut}
    />
  )
}
