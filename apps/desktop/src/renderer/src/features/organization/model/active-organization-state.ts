import { createContext, useContext } from 'react'
import type { PendingInvitation } from '../api/invitations'
import type { ActiveMembership } from '../api/memberships'

// Startup resolution state for the current Session: 'idle' has not started, 'resolving' is
// fetching Memberships and device memory, and 'ready' has taken one of the startup branches
// (entered an Organization, opened the picker, or begun onboarding).
export type OrganizationStartupPhase = 'idle' | 'resolving' | 'ready'

export interface ActiveOrganizationState {
  readonly startupPhase: OrganizationStartupPhase
  readonly activeOrganization: ActiveMembership | undefined
  readonly availableOrganizations: readonly ActiveMembership[]
  readonly pendingInvitations: readonly PendingInvitation[]
  readonly rememberedOrganizationId: string | undefined
  readonly enterOrganization: (membership: ActiveMembership) => void
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
