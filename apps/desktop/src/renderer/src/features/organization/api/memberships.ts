import { createOrganizationDataClient, type AuthenticatedOrganizationSession } from './client'

export type AuthenticatedMembershipSession = AuthenticatedOrganizationSession

export type OrganizationRole = 'owner' | 'admin' | 'member'

export interface ActiveMembership {
  readonly organizationId: string
  readonly organizationName: string
  readonly role: OrganizationRole
}

/**
 * Reads the Session's active Memberships straight from the Data API under RLS: the direct read
 * is the single source of truth for which Organizations the User may enter, and ended
 * Memberships never appear here.
 */
export async function readActiveMemberships(
  session: AuthenticatedMembershipSession
): Promise<readonly ActiveMembership[]> {
  const { data, error } = await createOrganizationDataClient(session)
    .from('memberships')
    .select('role, organizations(id, name)')
    .eq('user_id', session.userId)
    .eq('status', 'active')

  if (error) throw new Error('Membership request failed.')
  return data.map((row) => toActiveMembership(row))
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
