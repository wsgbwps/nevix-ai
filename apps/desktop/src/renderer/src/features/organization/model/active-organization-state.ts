import { createContext, useContext } from 'react'
import type { PendingInvitation } from '../api/invitations'
import type { ActiveMembership } from '../api/memberships'

// Startup resolution state for the current Session: 'idle' has not started, 'resolving' is
// fetching Memberships and device memory, and 'ready' has taken one of the startup branches
// (entered an Organization, opened the picker, or begun onboarding). 'failed' exposes a
// recoverable prerequisite failure instead of leaving the restoring boundary visible forever.
export type OrganizationStartupPhase = 'idle' | 'resolving' | 'failed' | 'ready'

export interface SessionAccessLostOrganization {
  readonly organizationId: string
  readonly organizationName: string
}

export type ActiveMembershipVerification =
  | {
      readonly status: 'verified'
      readonly membership: ActiveMembership
    }
  | { readonly status: 'lost'; readonly organizationId: string }
  | { readonly status: 'unknown'; readonly organizationId: string }

export class OrganizationSettingsAuthorityError extends Error {
  readonly verification: ActiveMembershipVerification

  constructor(verification: ActiveMembershipVerification) {
    super('Organization settings authority changed.')
    this.name = 'OrganizationSettingsAuthorityError'
    this.verification = verification
  }
}

export interface ActiveOrganizationState {
  readonly startupPhase: OrganizationStartupPhase
  readonly activeOrganization: ActiveMembership | undefined
  readonly membershipVerification: ActiveMembershipVerification | undefined
  readonly sessionAccessLostOrganization: SessionAccessLostOrganization | undefined
  readonly availableOrganizations: readonly ActiveMembership[]
  readonly pendingInvitations: readonly PendingInvitation[]
  readonly rememberedOrganizationId: string | undefined
  readonly retryStartup: () => void
  readonly enterOrganization: (membership: ActiveMembership) => void
  readonly openOrganizationPicker: () => void
  readonly leaveActiveOrganization: () => Promise<void>
  readonly updateActiveOrganizationName: (name: string) => Promise<void>
  readonly verifyActiveMembership: (options?: {
    readonly expectedLoss?: 'leave-command'
  }) => Promise<ActiveMembershipVerification>
  readonly confirmActiveOrganizationLeft: (organizationId: string) => void
  readonly acknowledgeSessionAccessLost: () => void
  readonly acceptInvitation: (invitation: PendingInvitation, code: string) => Promise<void>
  readonly reconcileStartupAfterInvitationChange: () => void
}

export const ActiveOrganizationContext = createContext<ActiveOrganizationState | null>(null)

export function useActiveOrganization(): ActiveOrganizationState {
  const state = useContext(ActiveOrganizationContext)
  if (state === null) {
    throw new Error('Active Organization state must be provided by the Organization Feature.')
  }
  return state
}
