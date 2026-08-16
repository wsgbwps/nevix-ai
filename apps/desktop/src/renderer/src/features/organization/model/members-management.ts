import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createOrganizationInvitation,
  readPendingOrganizationInvitations,
  resendOrganizationInvitation,
  revokeOrganizationInvitation,
  type PendingOrganizationInvitation
} from '../api/admin-invitations'
import type { AuthenticatedOrganizationSession } from '../api/client'
import { OrganizationCommandError } from '../api/command-client'
import {
  changeMemberRole,
  leaveOrganization as submitLeaveOrganization,
  readOrganizationMembers,
  removeMember as removeOrganizationMember,
  type ActiveMembership,
  type OrganizationMember
} from '../api/memberships'
import type { ActiveMembershipVerification } from './active-organization-state'
import { useActiveOrganization } from './active-organization-state'

type GetSession = () => Promise<AuthenticatedOrganizationSession | undefined>
type InvitationErrorCode =
  | 'active_membership_exists'
  | 'pending_invitation_exists'
  | 'cooldown_active'
  | 'email_rate_limited'
  | 'ip_rate_limited'
  | 'action_failed'

export type MembersCommandState = 'idle' | 'pending' | 'unknown'

export type MembersManagementNotice =
  | { readonly kind: 'sent'; readonly email: string }
  | { readonly kind: 'resent' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'roleUpdated'; readonly displayName: string }
  | { readonly kind: 'notApplied' }
  | { readonly kind: 'stateChanged' }
  | {
      readonly kind: 'error'
      readonly code: InvitationErrorCode
      readonly retryAfterSeconds: number | undefined
    }

interface ReconciledProjections {
  readonly verification: ActiveMembershipVerification
  readonly members: readonly OrganizationMember[]
  readonly invitations: readonly PendingOrganizationInvitation[]
  readonly currentUserId: string
}

type MutationResolution = 'applied' | 'safe-to-retry' | 'resolved' | 'unconfirmed'

interface MutationSpec {
  readonly command: (
    session: AuthenticatedOrganizationSession,
    signal: AbortSignal
  ) => Promise<void>
  readonly resolve: (projections: ReconciledProjections) => MutationResolution
  readonly successNotice: MembersManagementNotice | undefined
  readonly expectedMembershipLoss?: 'leave-command'
  readonly confirmWithoutProjection?: () => void
}

type CommandOutcome =
  | { readonly status: 'succeeded' }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'timed-out' }

class MembershipVerificationUnknownError extends Error {}

const commandTimeoutMilliseconds = 15_000

function canManageInvitations(verification: ActiveMembershipVerification): boolean {
  return (
    verification.status === 'verified' &&
    (verification.membership.role === 'owner' || verification.membership.role === 'admin')
  )
}

function noticeForCommandError(error: unknown): MembersManagementNotice {
  if (!(error instanceof OrganizationCommandError)) {
    return { kind: 'error', code: 'action_failed', retryAfterSeconds: undefined }
  }

  const code: InvitationErrorCode =
    error.code === 'active_membership_exists' ||
    error.code === 'pending_invitation_exists' ||
    error.code === 'cooldown_active' ||
    error.code === 'email_rate_limited' ||
    error.code === 'ip_rate_limited'
      ? error.code
      : 'action_failed'
  return { kind: 'error', code, retryAfterSeconds: error.retryAfterSeconds }
}

async function executeCommand(
  spec: MutationSpec,
  session: AuthenticatedOrganizationSession
): Promise<CommandOutcome> {
  const controller = new AbortController()
  let timedOut = false
  const command = spec.command(session, controller.signal).then(
    (): CommandOutcome => ({ status: 'succeeded' }),
    (error: unknown): CommandOutcome =>
      timedOut ? { status: 'timed-out' } : { status: 'failed', error }
  )

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<CommandOutcome>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true
      resolve({ status: 'timed-out' })
      controller.abort()
    }, commandTimeoutMilliseconds)
  })

  const outcome = await Promise.race([command, timeout])
  if (timeoutId !== undefined) clearTimeout(timeoutId)
  return outcome
}

export function useMembersManagement({
  getSession,
  organization,
  authorityFresh
}: {
  readonly getSession: GetSession
  readonly organization: ActiveMembership
  readonly authorityFresh: boolean
}): {
  readonly members: readonly OrganizationMember[]
  readonly pendingInvitations: readonly PendingOrganizationInvitation[]
  readonly currentUserId: string | undefined
  readonly loadState: 'loading' | 'ready' | 'error'
  readonly commandState: MembersCommandState
  readonly isRechecking: boolean
  readonly notice: MembersManagementNotice | undefined
  readonly clearNotice: () => void
  readonly reload: () => Promise<void>
  readonly checkUnknownResult: () => Promise<void>
  readonly createInvitation: (email: string) => Promise<boolean>
  readonly resendInvitation: (invitationId: string) => Promise<boolean>
  readonly revokeInvitation: (invitationId: string) => Promise<boolean>
  readonly promoteMember: (member: OrganizationMember) => Promise<boolean>
  readonly demoteMember: (member: OrganizationMember) => Promise<boolean>
  readonly removeMember: (member: OrganizationMember) => Promise<boolean>
  readonly leaveOrganization: () => Promise<boolean>
} {
  const { confirmActiveOrganizationLeft, verifyActiveMembership } = useActiveOrganization()
  const [members, setMembers] = useState<readonly OrganizationMember[]>([])
  const [pendingInvitations, setPendingInvitations] = useState<
    readonly PendingOrganizationInvitation[]
  >([])
  const [currentUserId, setCurrentUserId] = useState<string>()
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [commandState, setCommandState] = useState<MembersCommandState>('idle')
  const [isRechecking, setIsRechecking] = useState(false)
  const [notice, setNotice] = useState<MembersManagementNotice>()
  const loadVersionRef = useRef(0)
  const commandInFlightRef = useRef(false)
  const commandStateRef = useRef<MembersCommandState>('idle')
  const unknownCommandRef = useRef<MutationSpec | undefined>(undefined)
  const canManageCurrentInvitations =
    authorityFresh && (organization.role === 'owner' || organization.role === 'admin')

  const updateCommandState = useCallback((state: MembersCommandState): void => {
    commandStateRef.current = state
    setCommandState(state)
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    if (!authorityFresh || commandStateRef.current !== 'idle') return
    const version = loadVersionRef.current + 1
    loadVersionRef.current = version

    try {
      const session = await getSession()
      if (!session) throw new Error('Members management Session is unavailable.')
      if (loadVersionRef.current !== version) return
      setLoadState('loading')
      if (!canManageCurrentInvitations) setPendingInvitations([])

      const [nextMembers, nextInvitations] = await Promise.all([
        readOrganizationMembers(session, organization.organizationId),
        canManageCurrentInvitations
          ? readPendingOrganizationInvitations(session, organization.organizationId)
          : Promise.resolve([])
      ])
      if (loadVersionRef.current !== version) return
      if (nextMembers.length === 0) {
        const verification = await verifyActiveMembership()
        if (verification.status === 'lost') return
        if (verification.status === 'unknown') {
          throw new Error('Active Membership verification is unavailable.')
        }
        throw new Error('Organization member response is empty for an active Membership.')
      }

      setCurrentUserId(session.userId)
      setMembers(nextMembers)
      setPendingInvitations(nextInvitations)
      setLoadState('ready')
    } catch {
      if (loadVersionRef.current === version) setLoadState('error')
    }
  }, [
    authorityFresh,
    canManageCurrentInvitations,
    verifyActiveMembership,
    getSession,
    organization.organizationId
  ])

  useEffect(() => {
    let isMounted = true
    queueMicrotask(() => {
      if (isMounted) void reload()
    })
    return () => {
      isMounted = false
      loadVersionRef.current += 1
    }
  }, [reload])

  const reconcileProjections = useCallback(
    async (
      session: AuthenticatedOrganizationSession,
      expectedMembershipLoss?: 'leave-command'
    ): Promise<ReconciledProjections> => {
      const [verification, nextMembers, nextInvitations] = await Promise.all([
        verifyActiveMembership(
          expectedMembershipLoss === undefined
            ? undefined
            : { expectedLoss: expectedMembershipLoss }
        ),
        readOrganizationMembers(session, organization.organizationId),
        readPendingOrganizationInvitations(session, organization.organizationId)
      ])
      if (verification.status === 'unknown') {
        throw new MembershipVerificationUnknownError()
      }
      if (verification.status === 'verified' && nextMembers.length === 0) {
        throw new Error('Organization member response is empty for an active Membership.')
      }

      setCurrentUserId(session.userId)
      setMembers(nextMembers)
      setPendingInvitations(canManageInvitations(verification) ? nextInvitations : [])
      setLoadState('ready')
      return {
        verification,
        members: nextMembers,
        invitations: nextInvitations,
        currentUserId: session.userId
      }
    },
    [organization.organizationId, verifyActiveMembership]
  )

  const resolveMutation = useCallback(
    (spec: MutationSpec, projections: ReconciledProjections, outcome: CommandOutcome): boolean => {
      const resolution = spec.resolve(projections)
      if (resolution === 'unconfirmed' && outcome.status === 'timed-out') {
        unknownCommandRef.current = spec
        updateCommandState('unknown')
        return true
      }

      unknownCommandRef.current = undefined
      updateCommandState('idle')
      if (resolution === 'applied') {
        setNotice(spec.successNotice)
        return true
      }
      if (resolution === 'safe-to-retry') {
        setNotice(
          outcome.status === 'failed'
            ? noticeForCommandError(outcome.error)
            : { kind: 'notApplied' }
        )
        return outcome.status !== 'failed'
      }
      if (resolution === 'unconfirmed' && outcome.status === 'failed') {
        setNotice(noticeForCommandError(outcome.error))
        return false
      }

      setNotice({ kind: 'stateChanged' })
      return true
    },
    [updateCommandState]
  )

  const runMutation = useCallback(
    async (spec: MutationSpec): Promise<boolean> => {
      if (!authorityFresh || commandInFlightRef.current || commandStateRef.current !== 'idle') {
        return false
      }

      commandInFlightRef.current = true
      loadVersionRef.current += 1
      updateCommandState('pending')
      setNotice(undefined)
      try {
        const session = await getSession()
        if (!session) throw new Error('Members management Session is unavailable.')

        const outcome = await executeCommand(spec, session)
        try {
          const projections = await reconcileProjections(
            session,
            outcome.status === 'failed' ? undefined : spec.expectedMembershipLoss
          )
          return resolveMutation(spec, projections, outcome)
        } catch (error) {
          if (outcome.status === 'timed-out') {
            unknownCommandRef.current = spec
            updateCommandState('unknown')
            return true
          }

          updateCommandState('idle')
          if (!(error instanceof MembershipVerificationUnknownError)) setLoadState('error')
          if (outcome.status === 'succeeded') {
            spec.confirmWithoutProjection?.()
            setNotice(spec.successNotice)
            return true
          }
          setNotice(noticeForCommandError(outcome.error))
          return false
        }
      } catch (error) {
        updateCommandState('idle')
        setNotice(noticeForCommandError(error))
        return false
      } finally {
        commandInFlightRef.current = false
      }
    },
    [authorityFresh, getSession, reconcileProjections, resolveMutation, updateCommandState]
  )

  const checkUnknownResult = useCallback(async (): Promise<void> => {
    const spec = unknownCommandRef.current
    if (!spec || commandStateRef.current !== 'unknown' || commandInFlightRef.current) return

    commandInFlightRef.current = true
    loadVersionRef.current += 1
    setIsRechecking(true)
    try {
      const session = await getSession()
      if (!session) throw new Error('Members management Session is unavailable.')
      const projections = await reconcileProjections(session, spec.expectedMembershipLoss)
      resolveMutation(spec, projections, { status: 'timed-out' })
    } catch {
      updateCommandState('unknown')
    } finally {
      commandInFlightRef.current = false
      setIsRechecking(false)
    }
  }, [getSession, reconcileProjections, resolveMutation, updateCommandState])

  async function createInvitation(email: string): Promise<boolean> {
    const normalizedEmail = email.trim().toLowerCase()
    return runMutation({
      command: (session, signal) =>
        createOrganizationInvitation(session, organization.organizationId, normalizedEmail, signal),
      resolve: (projections) => {
        const invitationExists = projections.invitations.some(
          (invitation) => invitation.email.toLowerCase() === normalizedEmail
        )
        if (invitationExists) return 'applied'
        return 'unconfirmed'
      },
      successNotice: { kind: 'sent', email: email.trim() }
    })
  }

  async function resendInvitation(invitationId: string): Promise<boolean> {
    const previousExpiration = pendingInvitations.find(
      (invitation) => invitation.id === invitationId
    )?.expiresAt
    return runMutation({
      command: (session, signal) =>
        resendOrganizationInvitation(session, organization.organizationId, invitationId, signal),
      resolve: (projections) => {
        const invitation = projections.invitations.find(
          (candidate) => candidate.id === invitationId
        )
        if (!invitation) return 'resolved'
        if (previousExpiration !== undefined && invitation.expiresAt !== previousExpiration) {
          return 'applied'
        }
        return canManageInvitations(projections.verification) ? 'safe-to-retry' : 'resolved'
      },
      successNotice: { kind: 'resent' }
    })
  }

  async function revokeInvitation(invitationId: string): Promise<boolean> {
    return runMutation({
      command: (session, signal) =>
        revokeOrganizationInvitation(session, organization.organizationId, invitationId, signal),
      resolve: (projections) => {
        const invitationExists = projections.invitations.some(
          (invitation) => invitation.id === invitationId
        )
        if (!invitationExists) return 'applied'
        return canManageInvitations(projections.verification) ? 'safe-to-retry' : 'resolved'
      },
      successNotice: { kind: 'revoked' }
    })
  }

  async function promoteMember(member: OrganizationMember): Promise<boolean> {
    return changeRole(member, 'admin', 'promote')
  }

  async function demoteMember(member: OrganizationMember): Promise<boolean> {
    return changeRole(member, 'member', 'demote')
  }

  async function changeRole(
    member: OrganizationMember,
    expectedRole: 'admin' | 'member',
    action: 'promote' | 'demote'
  ): Promise<boolean> {
    return runMutation({
      command: (session, signal) =>
        changeMemberRole(session, organization.organizationId, member.membershipId, action, signal),
      resolve: (projections) => {
        const current = projections.members.find(
          (candidate) => candidate.membershipId === member.membershipId
        )
        if (current?.role === expectedRole) return 'applied'
        if (
          current &&
          current.userId !== projections.currentUserId &&
          projections.verification.status === 'verified' &&
          projections.verification.membership.role === 'owner' &&
          (current.role === 'admin' || current.role === 'member')
        ) {
          return 'safe-to-retry'
        }
        return 'resolved'
      },
      successNotice: { kind: 'roleUpdated', displayName: member.displayName }
    })
  }

  async function removeMember(member: OrganizationMember): Promise<boolean> {
    return runMutation({
      command: (session, signal) =>
        member.role === 'admin'
          ? changeMemberRole(
              session,
              organization.organizationId,
              member.membershipId,
              'remove',
              signal
            )
          : removeOrganizationMember(
              session,
              organization.organizationId,
              member.membershipId,
              signal
            ),
      resolve: (projections) => {
        const current = projections.members.find(
          (candidate) => candidate.membershipId === member.membershipId
        )
        if (!current) return 'applied'
        if (
          current.userId !== projections.currentUserId &&
          current.role !== 'owner' &&
          projections.verification.status === 'verified' &&
          (projections.verification.membership.role === 'owner' ||
            (projections.verification.membership.role === 'admin' && current.role === 'member'))
        ) {
          return 'safe-to-retry'
        }
        return 'resolved'
      },
      successNotice: undefined
    })
  }

  async function leaveOrganization(): Promise<boolean> {
    return runMutation({
      command: (session, signal) =>
        submitLeaveOrganization(session, organization.organizationId, signal),
      resolve: (projections) => {
        if (projections.verification.status === 'lost') return 'applied'
        if (projections.verification.status !== 'verified') return 'resolved'
        if (
          projections.verification.membership.role === 'admin' ||
          projections.verification.membership.role === 'member'
        ) {
          return 'safe-to-retry'
        }
        return 'resolved'
      },
      successNotice: undefined,
      expectedMembershipLoss: 'leave-command',
      confirmWithoutProjection: () => confirmActiveOrganizationLeft(organization.organizationId)
    })
  }

  function clearNotice(): void {
    setNotice(undefined)
  }

  return {
    members,
    pendingInvitations,
    currentUserId,
    loadState,
    commandState,
    isRechecking,
    notice,
    clearNotice,
    reload,
    checkUnknownResult,
    createInvitation,
    resendInvitation,
    revokeInvitation,
    promoteMember,
    demoteMember,
    removeMember,
    leaveOrganization
  }
}
