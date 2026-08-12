import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  acceptInvitation as acceptPendingInvitation,
  InvitationAcceptanceError,
  readPendingInvitations,
  type AcceptedInvitation,
  type PendingInvitation
} from '../api/invitations'
import type { AuthenticatedOrganizationSession } from '../api/client'
import { leaveOrganization, readActiveMemberships, type ActiveMembership } from '../api/memberships'
import { updateOrganizationSettings } from '../api/organization-settings'
import {
  ActiveOrganizationContext,
  type ActiveOrganizationState,
  type OrganizationStartupPhase
} from './active-organization-state'
import { reconcileStartupBranch, resolveStartupBranch } from './startup-resolution'
import { useOrganizationOnboarding } from './onboarding-state'

interface ActiveOrganizationProviderProps {
  readonly isAuthenticated: boolean
  readonly getSession: () => Promise<AuthenticatedOrganizationSession | undefined>
  readonly hasCompletedProfile: (session: AuthenticatedOrganizationSession) => Promise<boolean>
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
  hasCompletedProfile,
  children
}: ActiveOrganizationProviderProps): React.JSX.Element {
  const { beginOnboarding, resolveOnboarding } = useOrganizationOnboarding()
  const [startupPhase, setStartupPhase] = useState<OrganizationStartupPhase>('idle')
  const [activeOrganization, setActiveOrganization] = useState<ActiveMembership>()
  const [availableOrganizations, setAvailableOrganizations] = useState<readonly ActiveMembership[]>(
    []
  )
  const [pendingInvitations, setPendingInvitations] = useState<readonly PendingInvitation[]>([])
  const [rememberedOrganizationId, setRememberedOrganizationId] = useState<string>()
  const activeOrganizationRef = useRef<ActiveMembership | undefined>(undefined)
  const refreshActiveOrganizationRef = useRef<Promise<ActiveMembership | undefined> | null>(null)
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

  const openOrganizationPicker = useCallback((): void => {
    activeOrganizationRef.current = undefined
    setActiveOrganization(undefined)
    resolveOnboarding({
      shouldCompleteProfile: false,
      shouldCreateOrganization: false
    })
    setStartupPhase('ready')
  }, [resolveOnboarding])

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

  const reconcileStartupAfterInvitationChange = useCallback((): void => {
    reconcileStartupBranch(
      availableOrganizations,
      rememberedOrganizationId,
      pendingInvitations.length > 0,
      {
        beginOnboarding,
        enterOrganization
      }
    )
  }, [
    availableOrganizations,
    rememberedOrganizationId,
    pendingInvitations.length,
    beginOnboarding,
    enterOrganization
  ])

  useEffect(() => {
    activeOrganizationRef.current = activeOrganization
  }, [activeOrganization])

  const refreshActiveOrganization = useCallback((): Promise<ActiveMembership | undefined> => {
    const currentOrganization = activeOrganizationRef.current
    if (!isAuthenticated || !currentOrganization) return Promise.resolve(undefined)
    if (refreshActiveOrganizationRef.current) return refreshActiveOrganizationRef.current

    const refresh = (async (): Promise<ActiveMembership | undefined> => {
      const session = await getSession()
      if (!session) throw new Error('Active Organization Session is unavailable.')

      const memberships = await readActiveMemberships(session)
      const refreshedOrganization = memberships.find(
        (membership) => membership.organizationId === currentOrganization.organizationId
      )
      setAvailableOrganizations(memberships)
      setActiveOrganization((organization) =>
        organization?.organizationId === currentOrganization.organizationId
          ? refreshedOrganization
          : organization
      )
      return refreshedOrganization
    })()

    refreshActiveOrganizationRef.current = refresh
    const clearRefresh = (): void => {
      if (refreshActiveOrganizationRef.current === refresh) {
        refreshActiveOrganizationRef.current = null
      }
    }
    void refresh.then(clearRefresh, clearRefresh)
    return refresh
  }, [getSession, isAuthenticated])

  const leaveActiveOrganization = useCallback(async (): Promise<void> => {
    const currentOrganization = activeOrganizationRef.current
    if (!isAuthenticated || !currentOrganization) {
      throw new Error('Active Organization is unavailable.')
    }

    const session = await getSession()
    if (!session) throw new Error('Active Organization Session is unavailable.')

    await leaveOrganization(session, currentOrganization.organizationId)
    const memberships = await readActiveMemberships(session)
    activeOrganizationRef.current = undefined
    setActiveOrganization(undefined)
    setAvailableOrganizations(memberships)
    resolveOnboarding({
      shouldCompleteProfile: false,
      shouldCreateOrganization: memberships.length === 0 && pendingInvitations.length === 0
    })
    setStartupPhase('ready')
  }, [getSession, isAuthenticated, resolveOnboarding, pendingInvitations.length])

  const updateActiveOrganizationName = useCallback(
    async (name: string): Promise<void> => {
      const trimmedName = name.trim()
      if (trimmedName.length === 0) throw new Error('Organization name is required.')

      const currentOrganization = activeOrganizationRef.current
      if (!isAuthenticated || !currentOrganization) {
        throw new Error('Active Organization is unavailable.')
      }
      const session = await getSession()
      if (!session) throw new Error('Active Organization Session is unavailable.')

      const updated = await updateOrganizationSettings(
        session,
        currentOrganization.organizationId,
        trimmedName
      )
      const refreshed = await refreshActiveOrganization()
      if (
        !refreshed ||
        refreshed.organizationId !== updated.id ||
        refreshed.organizationName !== updated.name
      ) {
        throw new Error('Updated Active Organization is unavailable.')
      }
    },
    [getSession, isAuthenticated, refreshActiveOrganization]
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

        const [memberships, pending, remembered, profileCompleted] = await Promise.all([
          readActiveMemberships(session),
          readPendingInvitations(session),
          window.api.invoke('organization:get-remembered-active-organization'),
          hasCompletedProfile(session)
        ])
        if (resolutionRef.current !== 'running') return

        resolutionRef.current = 'done'
        setAvailableOrganizations(memberships)
        setPendingInvitations(pending)
        const rememberedId = remembered.organizationId ?? undefined
        setRememberedOrganizationId(rememberedId)

        const branch = resolveStartupBranch(memberships, rememberedId, pending.length > 0)
        resolveOnboarding({
          shouldCompleteProfile: !profileCompleted,
          shouldCreateOrganization: branch.kind === 'onboarding'
        })
        if (branch.kind === 'enter') {
          enterOrganization(branch.membership)
          return
        }

        setStartupPhase('ready')
      } catch {
        resolutionRef.current = 'failed'
      }
    })()
  }, [
    isAuthenticated,
    resolveOnboarding,
    activeOrganization,
    getSession,
    hasCompletedProfile,
    enterOrganization
  ])

  const value = useMemo<ActiveOrganizationState>(
    () => ({
      startupPhase,
      activeOrganization,
      availableOrganizations,
      pendingInvitations,
      rememberedOrganizationId,
      enterOrganization,
      openOrganizationPicker,
      leaveActiveOrganization,
      updateActiveOrganizationName,
      refreshActiveOrganization,
      acceptInvitation,
      reconcileStartupAfterInvitationChange
    }),
    [
      startupPhase,
      activeOrganization,
      availableOrganizations,
      pendingInvitations,
      rememberedOrganizationId,
      enterOrganization,
      openOrganizationPicker,
      leaveActiveOrganization,
      updateActiveOrganizationName,
      refreshActiveOrganization,
      acceptInvitation,
      reconcileStartupAfterInvitationChange
    ]
  )

  return (
    <ActiveOrganizationContext.Provider value={value}>
      {children}
    </ActiveOrganizationContext.Provider>
  )
}
