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
  readOrganizationMembers,
  removeMember as removeOrganizationMember,
  type ActiveMembership,
  type OrganizationMember
} from '../api/memberships'

type GetSession = () => Promise<AuthenticatedOrganizationSession | undefined>
type Projection = 'members' | 'invitations'
type InvitationErrorCode =
  | 'active_membership_exists'
  | 'pending_invitation_exists'
  | 'cooldown_active'
  | 'email_rate_limited'
  | 'ip_rate_limited'
  | 'action_failed'

export type MembersManagementNotice =
  | { readonly kind: 'sent'; readonly email: string }
  | { readonly kind: 'resent' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'roleUpdated'; readonly displayName: string }
  | {
      readonly kind: 'error'
      readonly code: InvitationErrorCode
      readonly retryAfterSeconds: number | undefined
    }

const staleInvitationCodes: Readonly<Record<string, true>> = {
  invitation_not_found: true,
  invitation_not_pending: true,
  invitation_revoked: true,
  invitation_expired: true
}

const staleMembershipCodes: Readonly<Record<string, true>> = {
  organization_not_found: true,
  membership_not_found: true,
  membership_not_member: true,
  membership_not_admin: true,
  insufficient_organization_role: true
}

export function useMembersManagement({
  getSession,
  organization
}: {
  readonly getSession: GetSession
  readonly organization: ActiveMembership
}): {
  readonly members: readonly OrganizationMember[]
  readonly pendingInvitations: readonly PendingOrganizationInvitation[]
  readonly currentUserId: string | undefined
  readonly loadState: 'loading' | 'ready' | 'error'
  readonly isMutating: boolean
  readonly notice: MembersManagementNotice | undefined
  readonly clearNotice: () => void
  readonly reload: () => Promise<void>
  readonly createInvitation: (email: string) => Promise<boolean>
  readonly resendInvitation: (invitationId: string) => Promise<boolean>
  readonly revokeInvitation: (invitationId: string) => Promise<boolean>
  readonly promoteMember: (member: OrganizationMember) => Promise<boolean>
  readonly demoteMember: (member: OrganizationMember) => Promise<boolean>
  readonly removeMember: (member: OrganizationMember) => Promise<boolean>
} {
  const [members, setMembers] = useState<readonly OrganizationMember[]>([])
  const [pendingInvitations, setPendingInvitations] = useState<
    readonly PendingOrganizationInvitation[]
  >([])
  const [currentUserId, setCurrentUserId] = useState<string>()
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [isMutating, setIsMutating] = useState(false)
  const [notice, setNotice] = useState<MembersManagementNotice>()
  const loadVersionRef = useRef(0)
  const mutationInFlightRef = useRef(false)
  const canManageInvitations = organization.role === 'owner' || organization.role === 'admin'

  const reload = useCallback(async (): Promise<void> => {
    const version = loadVersionRef.current + 1
    loadVersionRef.current = version

    try {
      const session = await getSession()
      if (!session) throw new Error('Members management Session is unavailable.')
      if (loadVersionRef.current !== version) return
      setLoadState('loading')
      if (!canManageInvitations) setPendingInvitations([])

      const [nextMembers, nextInvitations] = await Promise.all([
        readOrganizationMembers(session, organization.organizationId),
        canManageInvitations
          ? readPendingOrganizationInvitations(session, organization.organizationId)
          : Promise.resolve([])
      ])
      if (loadVersionRef.current !== version) return

      setCurrentUserId(session.userId)
      setMembers(nextMembers)
      setPendingInvitations(nextInvitations)
      setLoadState('ready')
    } catch {
      if (loadVersionRef.current === version) setLoadState('error')
    }
  }, [canManageInvitations, getSession, organization.organizationId])
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

  const runMutation = useCallback(
    async (
      command: (session: AuthenticatedOrganizationSession) => Promise<void>,
      projection: Projection,
      successNotice: MembersManagementNotice | undefined
    ): Promise<boolean> => {
      if (mutationInFlightRef.current) return false

      mutationInFlightRef.current = true
      loadVersionRef.current += 1
      setIsMutating(true)
      setNotice(undefined)
      try {
        const session = await getSession()
        if (!session) throw new Error('Members management Session is unavailable.')

        await command(session)
        try {
          if (projection === 'members') {
            setMembers(await readOrganizationMembers(session, organization.organizationId))
          } else if (canManageInvitations) {
            setPendingInvitations(
              await readPendingOrganizationInvitations(session, organization.organizationId)
            )
          }
        } catch {
          setLoadState('error')
          return true
        }
        setLoadState('ready')
        setNotice(successNotice)
        return true
      } catch (error) {
        if (error instanceof OrganizationCommandError) {
          const staleProjection =
            staleInvitationCodes[error.code] === true
              ? 'invitations'
              : staleMembershipCodes[error.code] === true
                ? 'members'
                : undefined
          if (staleProjection) {
            try {
              const session = await getSession()
              if (session && staleProjection === 'members') {
                setMembers(await readOrganizationMembers(session, organization.organizationId))
              } else if (session && canManageInvitations) {
                setPendingInvitations(
                  await readPendingOrganizationInvitations(session, organization.organizationId)
                )
              }
            } catch {
              setLoadState('error')
            }
          }

          const specificCode: InvitationErrorCode =
            error.code === 'active_membership_exists' ||
            error.code === 'pending_invitation_exists' ||
            error.code === 'cooldown_active' ||
            error.code === 'email_rate_limited' ||
            error.code === 'ip_rate_limited'
              ? error.code
              : 'action_failed'
          setNotice({
            kind: 'error',
            code: specificCode,
            retryAfterSeconds: error.retryAfterSeconds
          })
        } else {
          setNotice({ kind: 'error', code: 'action_failed', retryAfterSeconds: undefined })
        }
        return false
      } finally {
        mutationInFlightRef.current = false
        setIsMutating(false)
      }
    },
    [canManageInvitations, getSession, organization.organizationId]
  )

  async function createInvitation(email: string): Promise<boolean> {
    const normalizedEmail = email.trim()
    return runMutation(
      (session) =>
        createOrganizationInvitation(session, organization.organizationId, normalizedEmail),
      'invitations',
      { kind: 'sent', email: normalizedEmail }
    )
  }

  async function resendInvitation(invitationId: string): Promise<boolean> {
    return runMutation(
      (session) => resendOrganizationInvitation(session, organization.organizationId, invitationId),
      'invitations',
      { kind: 'resent' }
    )
  }

  async function revokeInvitation(invitationId: string): Promise<boolean> {
    return runMutation(
      (session) => revokeOrganizationInvitation(session, organization.organizationId, invitationId),
      'invitations',
      { kind: 'revoked' }
    )
  }

  async function promoteMember(member: OrganizationMember): Promise<boolean> {
    return runMutation(
      (session) =>
        changeMemberRole(session, organization.organizationId, member.membershipId, 'promote'),
      'members',
      { kind: 'roleUpdated', displayName: member.displayName }
    )
  }

  async function demoteMember(member: OrganizationMember): Promise<boolean> {
    return runMutation(
      (session) =>
        changeMemberRole(session, organization.organizationId, member.membershipId, 'demote'),
      'members',
      { kind: 'roleUpdated', displayName: member.displayName }
    )
  }

  async function removeMember(member: OrganizationMember): Promise<boolean> {
    return runMutation(
      (session) =>
        member.role === 'admin'
          ? changeMemberRole(session, organization.organizationId, member.membershipId, 'remove')
          : removeOrganizationMember(session, organization.organizationId, member.membershipId),
      'members',
      undefined
    )
  }

  function clearNotice(): void {
    setNotice(undefined)
  }

  return {
    members,
    pendingInvitations,
    currentUserId,
    loadState,
    isMutating,
    notice,
    clearNotice,
    reload,
    createInvitation,
    resendInvitation,
    revokeInvitation,
    promoteMember,
    demoteMember,
    removeMember
  }
}
