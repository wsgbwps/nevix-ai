import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  acceptInvitation as acceptPendingInvitation,
  InvitationAcceptanceError,
  readPendingInvitations,
  type AcceptedInvitation,
  type PendingInvitation
} from '../api/invitations'
import type { AuthenticatedOrganizationSession } from '../api/client'
import { readActiveMemberships, type ActiveMembership } from '../api/memberships'
import {
  ActiveOrganizationContext,
  type ActiveOrganizationState,
  type OrganizationStartupPhase
} from './active-organization-state'
import { resolveStartupBranch } from './startup-resolution'
import { useOrganizationOnboarding } from './onboarding-state'

interface ActiveOrganizationProviderProps {
  readonly isAuthenticated: boolean
  readonly getSession: () => Promise<AuthenticatedOrganizationSession | undefined>
  readonly children: React.ReactNode
}

/**
 * Holds the Active Organization in renderer memory and runs the startup verification once per
 * authenticated Session: reads active Memberships (RLS direct read, the single source of truth)
 * plus the remembered Organization id from main-process persistence, then takes one branch —
 * remembered Membership valid enters directly, zero Organizations begins onboarding, a single
 * Organization is auto-selected only without a device memory, and everything else lands on the
 * Organization picker. A remembered Membership that has ended therefore never auto-enters.
 *
 * The composition root remounts this provider whenever authentication status changes, so the
 * state of a signed-out Session can never leak into the next Session.
 */
export function ActiveOrganizationProvider({
  isAuthenticated,
  getSession,
  children
}: ActiveOrganizationProviderProps): React.JSX.Element {
  const onboarding = useOrganizationOnboarding()
  const [startupPhase, setStartupPhase] = useState<OrganizationStartupPhase>('idle')
  const [activeOrganization, setActiveOrganization] = useState<ActiveMembership>()
  const [availableOrganizations, setAvailableOrganizations] = useState<readonly ActiveMembership[]>(
    []
  )
  const [pendingInvitations, setPendingInvitations] = useState<readonly PendingInvitation[]>([])
  const [rememberedOrganizationId, setRememberedOrganizationId] = useState<string>()
  // The startup verification runs at most once per authenticated Session; a failed fetch stays
  // on the restoring view instead of retrying in a loop.
  const resolutionRef = useRef<'none' | 'running' | 'done' | 'failed'>('none')

  const enterOrganization = useCallback((membership: ActiveMembership): void => {
    setActiveOrganization(membership)
    setRememberedOrganizationId(membership.organizationId)
    setAvailableOrganizations((organizations) =>
      organizations.some((each) => each.organizationId === membership.organizationId)
        ? organizations
        : [...organizations, membership]
    )
    setStartupPhase('ready')
    void window.api.invoke('organization:set-remembered-active-organization', {
      organizationId: membership.organizationId
    })
  }, [])

  const acceptInvitation = useCallback(
    async (invitation: PendingInvitation, code: string): Promise<void> => {
      const session = await getSession()
      if (!session) throw new Error('Invitation acceptance Session is unavailable.')

      let accepted: AcceptedInvitation
      try {
        accepted = await acceptPendingInvitation({
          session,
          invitationId: invitation.id,
          code
        })
      } catch (error) {
        if (error instanceof InvitationAcceptanceError && error.code === 'invitation_revoked') {
          setPendingInvitations((invitations) =>
            invitations.filter((candidate) => candidate.id !== invitation.id)
          )
        }
        throw error
      }
      // The command return is confirmation only. Re-read active Memberships under RLS so the
      // Data API remains the source of truth for the Organization the Desktop enters.
      const memberships = await readActiveMemberships(session)
      const membership = memberships.find(
        (candidate) => candidate.organizationId === accepted.organizationId
      )
      if (!membership) throw new Error('Accepted Organization Membership is unavailable.')

      setAvailableOrganizations(memberships)
      setPendingInvitations((invitations) =>
        invitations.filter((candidate) => candidate.id !== invitation.id)
      )
      enterOrganization(membership)
    },
    [getSession, enterOrganization]
  )

  useEffect(() => {
    if (!isAuthenticated) return
    if (activeOrganization) return
    if (resolutionRef.current !== 'none') return

    resolutionRef.current = 'running'
    setStartupPhase('resolving')
    void (async () => {
      try {
        const session = await getSession()
        if (resolutionRef.current !== 'running') return
        if (!session) {
          resolutionRef.current = 'failed'
          return
        }

        const [memberships, pending, remembered] = await Promise.all([
          readActiveMemberships(session),
          readPendingInvitations(session),
          window.api.invoke('organization:get-remembered-active-organization')
        ])
        if (resolutionRef.current !== 'running') return

        resolutionRef.current = 'done'
        setAvailableOrganizations(memberships)
        setPendingInvitations(pending)
        const rememberedId = remembered.organizationId ?? undefined
        setRememberedOrganizationId(rememberedId)

        const branch = resolveStartupBranch(memberships, rememberedId, pending.length > 0)
        if (branch.kind === 'onboarding') {
          setStartupPhase('ready')
          onboarding.beginOnboarding()
          return
        }

        if (pending.length > 0) {
          // A fresh invitee still needs to finish the global Profile, but the pending Invitation
          // supplies the Organization entry path. Keep registration eligibility while skipping
          // only first-Organization creation; an existing User remains ineligible and sees the
          // picker directly.
          onboarding.skipOrganizationCreation()
        } else {
          onboarding.completeOnboarding()
        }
        if (branch.kind === 'enter') {
          enterOrganization(branch.membership)
          return
        }

        setStartupPhase('ready')
      } catch {
        resolutionRef.current = 'failed'
      }
    })()
  }, [isAuthenticated, onboarding, activeOrganization, getSession, enterOrganization])

  const value = useMemo<ActiveOrganizationState>(
    () => ({
      startupPhase,
      activeOrganization,
      availableOrganizations,
      pendingInvitations,
      rememberedOrganizationId,
      enterOrganization,
      acceptInvitation
    }),
    [
      startupPhase,
      activeOrganization,
      availableOrganizations,
      pendingInvitations,
      rememberedOrganizationId,
      enterOrganization,
      acceptInvitation
    ]
  )

  return (
    <ActiveOrganizationContext.Provider value={value}>
      {children}
    </ActiveOrganizationContext.Provider>
  )
}
