import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  acceptInvitation as acceptPendingInvitation,
  InvitationAcceptanceError,
  readPendingInvitations,
  type AcceptedInvitation,
  type PendingInvitation
} from '../api/invitations'
import type { AuthenticatedOrganizationSession } from '../api/client'
import { isPotentialOrganizationAccessLoss } from '../api/command-client'
import { leaveOrganization, readActiveMemberships, type ActiveMembership } from '../api/memberships'
import { updateOrganizationSettings } from '../api/organization-settings'
import {
  ActiveOrganizationContext,
  OrganizationSettingsAuthorityError,
  type ActiveMembershipVerification,
  type ActiveOrganizationState,
  type OrganizationStartupPhase,
  type SessionAccessLostOrganization
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
  const [membershipVerification, setMembershipVerification] =
    useState<ActiveMembershipVerification>()
  const [sessionAccessLostOrganization, setSessionAccessLostOrganization] =
    useState<SessionAccessLostOrganization>()
  const [availableOrganizations, setAvailableOrganizations] = useState<readonly ActiveMembership[]>(
    []
  )
  const [pendingInvitations, setPendingInvitations] = useState<readonly PendingInvitation[]>([])
  const [rememberedOrganizationId, setRememberedOrganizationId] = useState<string>()
  const [startupAttempt, setStartupAttempt] = useState(0)
  const activeOrganizationRef = useRef<ActiveMembership | undefined>(undefined)
  const availableOrganizationsRef = useRef<readonly ActiveMembership[]>([])
  const membershipVerificationRef = useRef<ActiveMembershipVerification | undefined>(undefined)
  // Only the newest Membership projection may update Organization state.
  const refreshGenerationRef = useRef(0)
  // A startup attempt never repeats on its own. A failed attempt can only be replaced by one
  // explicit user retry.
  const resolutionRef = useRef<'none' | 'running' | 'done' | 'failed'>('none')

  const retryStartup = useCallback((): void => {
    if (!isAuthenticated || resolutionRef.current !== 'failed') return

    resolutionRef.current = 'none'
    setStartupAttempt((attempt) => attempt + 1)
  }, [isAuthenticated])

  const updateMembershipVerification = useCallback(
    (verification: ActiveMembershipVerification | undefined): void => {
      membershipVerificationRef.current = verification
      setMembershipVerification(verification)
    },
    []
  )

  const enterOrganization = useCallback(
    (membership: ActiveMembership): void => {
      setActiveOrganization(membership)
      updateMembershipVerification({ status: 'verified', membership })
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
    },
    [updateMembershipVerification]
  )

  const openOrganizationPicker = useCallback((): void => {
    activeOrganizationRef.current = undefined
    setActiveOrganization(undefined)
    updateMembershipVerification(undefined)
    resolveOnboarding({
      shouldCompleteProfile: false,
      shouldCreateOrganization: false
    })
    setStartupPhase('ready')
  }, [resolveOnboarding, updateMembershipVerification])

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

  useEffect(() => {
    availableOrganizationsRef.current = availableOrganizations
  }, [availableOrganizations])

  const acknowledgeSessionAccessLost = useCallback((): void => {
    setSessionAccessLostOrganization(undefined)
  }, [])

  const confirmActiveOrganizationLeft = useCallback(
    (organizationId: string): void => {
      const currentOrganization = activeOrganizationRef.current
      if (currentOrganization?.organizationId !== organizationId) return

      refreshGenerationRef.current += 1
      activeOrganizationRef.current = undefined
      setActiveOrganization(undefined)
      updateMembershipVerification({ status: 'lost', organizationId })
      const remainingOrganizations = availableOrganizationsRef.current.filter(
        (organization) => organization.organizationId !== organizationId
      )
      availableOrganizationsRef.current = remainingOrganizations
      setAvailableOrganizations(remainingOrganizations)
      setStartupPhase('ready')
    },
    [updateMembershipVerification]
  )

  const verifyActiveMembership = useCallback(
    async (options?: {
      readonly expectedLoss?: 'leave-command'
    }): Promise<ActiveMembershipVerification> => {
      const currentOrganization = activeOrganizationRef.current
      if (!isAuthenticated || !currentOrganization) {
        return { status: 'lost', organizationId: currentOrganization?.organizationId ?? '' }
      }

      const requestGeneration = ++refreshGenerationRef.current
      try {
        const session = await getSession()
        if (!session) throw new Error('Active Organization Session is unavailable.')
        const memberships = await readActiveMemberships(session)

        if (
          requestGeneration !== refreshGenerationRef.current ||
          activeOrganizationRef.current?.organizationId !== currentOrganization.organizationId
        ) {
          const latestVerification = membershipVerificationRef.current
          const latestOrganizationId =
            latestVerification?.status === 'verified'
              ? latestVerification.membership.organizationId
              : latestVerification?.organizationId
          return latestVerification && latestOrganizationId === currentOrganization.organizationId
            ? latestVerification
            : { status: 'unknown', organizationId: currentOrganization.organizationId }
        }

        const membership = memberships.find(
          (candidate) => candidate.organizationId === currentOrganization.organizationId
        )
        availableOrganizationsRef.current = memberships
        setAvailableOrganizations(memberships)
        if (membership) {
          const result = { status: 'verified', membership } as const
          activeOrganizationRef.current = membership
          setActiveOrganization(membership)
          updateMembershipVerification(result)
          return result
        }

        const result = {
          status: 'lost',
          organizationId: currentOrganization.organizationId
        } as const
        confirmActiveOrganizationLeft(currentOrganization.organizationId)
        resolveOnboarding({
          shouldCompleteProfile: false,
          shouldCreateOrganization: memberships.length === 0 && pendingInvitations.length === 0
        })
        if (options?.expectedLoss !== 'leave-command') {
          setSessionAccessLostOrganization(
            (lostOrganization) => lostOrganization ?? currentOrganization
          )
        }
        return result
      } catch {
        const result = {
          status: 'unknown',
          organizationId: currentOrganization.organizationId
        } as const
        if (
          requestGeneration === refreshGenerationRef.current &&
          activeOrganizationRef.current?.organizationId === currentOrganization.organizationId
        ) {
          updateMembershipVerification(result)
          return result
        }

        const latestVerification = membershipVerificationRef.current
        const latestOrganizationId =
          latestVerification?.status === 'verified'
            ? latestVerification.membership.organizationId
            : latestVerification?.organizationId
        return latestVerification && latestOrganizationId === currentOrganization.organizationId
          ? latestVerification
          : result
      }
    },
    [
      getSession,
      isAuthenticated,
      confirmActiveOrganizationLeft,
      pendingInvitations.length,
      resolveOnboarding,
      updateMembershipVerification
    ]
  )

  const leaveActiveOrganization = useCallback(async (): Promise<void> => {
    const currentOrganization = activeOrganizationRef.current
    if (!isAuthenticated || !currentOrganization) {
      throw new Error('Active Organization is unavailable.')
    }

    const session = await getSession()
    if (!session) throw new Error('Active Organization Session is unavailable.')

    try {
      await leaveOrganization(session, currentOrganization.organizationId)
    } catch (error) {
      if (isPotentialOrganizationAccessLoss(error)) {
        await verifyActiveMembership()
      }
      throw error
    }
    confirmActiveOrganizationLeft(currentOrganization.organizationId)
    const requestGeneration = refreshGenerationRef.current

    try {
      const memberships = await readActiveMemberships(session)
      if (requestGeneration !== refreshGenerationRef.current) return

      availableOrganizationsRef.current = memberships
      setAvailableOrganizations(memberships)
      resolveOnboarding({
        shouldCompleteProfile: false,
        shouldCreateOrganization: memberships.length === 0 && pendingInvitations.length === 0
      })
      setStartupPhase('ready')
    } catch {
      // The command already committed, so preserve the cleared Organization context.
    }
  }, [
    verifyActiveMembership,
    confirmActiveOrganizationLeft,
    getSession,
    isAuthenticated,
    resolveOnboarding,
    pendingInvitations.length
  ])

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

      let updated: { readonly id: string; readonly name: string }
      try {
        updated = await updateOrganizationSettings(
          session,
          currentOrganization.organizationId,
          trimmedName
        )
      } catch (error) {
        if (isPotentialOrganizationAccessLoss(error)) {
          const verification = await verifyActiveMembership()
          throw new OrganizationSettingsAuthorityError(verification)
        }
        throw error
      }
      const updatedOrganization = {
        ...currentOrganization,
        organizationId: updated.id,
        organizationName: updated.name
      }
      activeOrganizationRef.current = updatedOrganization
      setActiveOrganization(updatedOrganization)
      if (membershipVerificationRef.current?.status === 'verified') {
        updateMembershipVerification({ status: 'verified', membership: updatedOrganization })
      }
      setAvailableOrganizations((organizations) =>
        organizations.map((organization) =>
          organization.organizationId === updated.id
            ? { ...organization, organizationName: updated.name }
            : organization
        )
      )
      void verifyActiveMembership()
    },
    [getSession, isAuthenticated, updateMembershipVerification, verifyActiveMembership]
  )

  useEffect(() => {
    if (!isAuthenticated) return
    if (activeOrganization) return
    if (resolutionRef.current !== 'none') return

    let cancelled = false
    resolutionRef.current = 'running'
    setStartupPhase('resolving')
    void (async () => {
      try {
        const session = await getSession()
        if (cancelled || resolutionRef.current !== 'running') return
        if (!session) {
          resolutionRef.current = 'failed'
          setStartupPhase('failed')
          return
        }

        const [memberships, pending, remembered, profileCompleted] = await Promise.all([
          readActiveMemberships(session),
          readPendingInvitations(session),
          window.api.invoke('organization:get-remembered-active-organization'),
          hasCompletedProfile(session)
        ])
        if (cancelled || resolutionRef.current !== 'running') return

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
        if (cancelled || resolutionRef.current !== 'running') return
        resolutionRef.current = 'failed'
        setStartupPhase('failed')
      }
    })()

    return () => {
      cancelled = true
      if (resolutionRef.current === 'running') resolutionRef.current = 'none'
    }
  }, [
    isAuthenticated,
    resolveOnboarding,
    activeOrganization,
    getSession,
    hasCompletedProfile,
    enterOrganization,
    startupAttempt
  ])

  const value = useMemo<ActiveOrganizationState>(
    () => ({
      startupPhase,
      activeOrganization,
      membershipVerification,
      sessionAccessLostOrganization,
      availableOrganizations,
      pendingInvitations,
      rememberedOrganizationId,
      retryStartup,
      enterOrganization,
      openOrganizationPicker,
      leaveActiveOrganization,
      updateActiveOrganizationName,
      verifyActiveMembership,
      confirmActiveOrganizationLeft,
      acknowledgeSessionAccessLost,
      acceptInvitation,
      reconcileStartupAfterInvitationChange
    }),
    [
      startupPhase,
      activeOrganization,
      membershipVerification,
      sessionAccessLostOrganization,
      availableOrganizations,
      pendingInvitations,
      rememberedOrganizationId,
      retryStartup,
      enterOrganization,
      openOrganizationPicker,
      leaveActiveOrganization,
      updateActiveOrganizationName,
      verifyActiveMembership,
      confirmActiveOrganizationLeft,
      acknowledgeSessionAccessLost,
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
