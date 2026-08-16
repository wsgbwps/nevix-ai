import { createOrganizationDataClient, type AuthenticatedOrganizationSession } from './client'
import { requestOrganizationCommand } from './command-client'

export type OrganizationRole = 'owner' | 'admin' | 'member'

export interface ActiveMembership {
  readonly organizationId: string
  readonly organizationName: string
  readonly role: OrganizationRole
}

export interface OrganizationMember {
  readonly membershipId: string
  readonly userId: string
  readonly displayName: string
  readonly role: OrganizationRole
}

interface MembershipProjection {
  readonly membershipId: string
  readonly userId: string
  readonly role: OrganizationRole
}

/**
 * Reads the Session's active Memberships straight from the Data API under RLS: the direct read
 * is the single source of truth for which Organizations the User may enter, and ended
 * Memberships never appear here.
 */
export async function readActiveMemberships(
  session: AuthenticatedOrganizationSession
): Promise<readonly ActiveMembership[]> {
  const { data, error } = await createOrganizationDataClient(session)
    .from('memberships')
    .select('role, organizations(id, name)')
    .eq('user_id', session.userId)
    .eq('status', 'active')

  if (error) throw new Error('Membership request failed.')
  return data.map((row) => toActiveMembership(row))
}

export async function readOrganizationMembers(
  session: AuthenticatedOrganizationSession,
  organizationId: string
): Promise<readonly OrganizationMember[]> {
  const client = createOrganizationDataClient(session)
  const { data: membershipData, error: membershipError } = await client
    .from('memberships')
    .select('id, user_id, role, created_at')
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .order('created_at', { ascending: true })

  if (membershipError) throw new Error('Organization member request failed.')
  const memberships = membershipData.map((row) => toMembershipProjection(row))
  if (memberships.length === 0) return []

  const { data: profileData, error: profileError } = await client
    .from('profiles')
    .select('user_id, display_name')
    .in(
      'user_id',
      memberships.map((membership) => membership.userId)
    )

  if (profileError) throw new Error('Organization member Profile request failed.')
  const displayNames = new Map<string, string>()
  for (const value of profileData) {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('user_id' in value) ||
      !('display_name' in value) ||
      typeof value.user_id !== 'string' ||
      value.user_id.length === 0 ||
      typeof value.display_name !== 'string' ||
      value.display_name.length === 0 ||
      displayNames.has(value.user_id)
    ) {
      throw new Error('Organization member Profile response is invalid.')
    }
    displayNames.set(value.user_id, value.display_name)
  }

  return memberships.map((membership) => {
    const displayName = displayNames.get(membership.userId)
    if (!displayName) throw new Error('Organization member Profile response is incomplete.')
    return { ...membership, displayName }
  })
}

export async function changeMemberRole(
  session: AuthenticatedOrganizationSession,
  organizationId: string,
  membershipId: string,
  action: 'promote' | 'demote' | 'remove',
  signal?: AbortSignal
): Promise<void> {
  const response = await requestOrganizationCommand({
    accessToken: session.accessToken,
    method: 'POST',
    path: `/identity/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(membershipId)}/role`,
    body: { action },
    signal
  })
  validateMembershipCommandResponse(response, {
    organizationId,
    membershipId,
    expectedRole: action === 'promote' ? 'admin' : action === 'demote' ? 'member' : undefined,
    expectedStatus: action === 'remove' ? 'ended' : 'active'
  })
}

export async function removeMember(
  session: AuthenticatedOrganizationSession,
  organizationId: string,
  membershipId: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await requestOrganizationCommand({
    accessToken: session.accessToken,
    method: 'POST',
    path: `/identity/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(membershipId)}/remove`,
    body: {},
    signal
  })
  validateMembershipCommandResponse(response, {
    organizationId,
    membershipId,
    expectedStatus: 'ended'
  })
}

export async function leaveOrganization(
  session: AuthenticatedOrganizationSession,
  organizationId: string,
  signal?: AbortSignal
): Promise<void> {
  const response = await requestOrganizationCommand({
    accessToken: session.accessToken,
    method: 'POST',
    path: `/identity/organizations/${encodeURIComponent(organizationId)}/leave`,
    body: {},
    signal
  })
  validateMembershipCommandResponse(response, {
    organizationId,
    userId: session.userId,
    expectedStatus: 'ended'
  })
}

function toActiveMembership(value: unknown): ActiveMembership {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Membership response is invalid.')
  }

  const row = value as { role?: unknown; organizations?: unknown }
  if (row.role !== 'owner' && row.role !== 'admin' && row.role !== 'member') {
    throw new Error('Membership response is invalid.')
  }

  const organization = row.organizations
  if (typeof organization !== 'object' || organization === null) {
    throw new Error('Membership response is invalid.')
  }

  const { id, name } = organization as { id?: unknown; name?: unknown }
  if (typeof id !== 'string' || typeof name !== 'string') {
    throw new Error('Membership response is invalid.')
  }

  return { organizationId: id, organizationName: name, role: row.role }
}

function toMembershipProjection(value: unknown): MembershipProjection {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !('user_id' in value) ||
    !('role' in value) ||
    !('created_at' in value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.user_id !== 'string' ||
    value.user_id.length === 0 ||
    (value.role !== 'owner' && value.role !== 'admin' && value.role !== 'member') ||
    typeof value.created_at !== 'string' ||
    Number.isNaN(Date.parse(value.created_at))
  ) {
    throw new Error('Organization member response is invalid.')
  }
  return { membershipId: value.id, userId: value.user_id, role: value.role }
}

function validateMembershipCommandResponse(
  value: unknown,
  expected: {
    readonly organizationId: string
    readonly membershipId?: string
    readonly userId?: string
    readonly expectedRole?: OrganizationRole
    readonly expectedStatus: 'active' | 'ended'
  }
): void {
  if (typeof value !== 'object' || value === null || !('membership' in value)) {
    throw new Error('Membership command response is invalid.')
  }
  const membership = value.membership
  if (
    typeof membership !== 'object' ||
    membership === null ||
    !('id' in membership) ||
    !('organization_id' in membership) ||
    !('user_id' in membership) ||
    !('role' in membership) ||
    !('status' in membership) ||
    typeof membership.id !== 'string' ||
    (expected.membershipId !== undefined && membership.id !== expected.membershipId) ||
    membership.organization_id !== expected.organizationId ||
    typeof membership.user_id !== 'string' ||
    (expected.userId !== undefined && membership.user_id !== expected.userId) ||
    (membership.role !== 'owner' && membership.role !== 'admin' && membership.role !== 'member') ||
    (expected.expectedRole !== undefined && membership.role !== expected.expectedRole) ||
    membership.status !== expected.expectedStatus
  ) {
    throw new Error('Membership command response is invalid.')
  }
}
