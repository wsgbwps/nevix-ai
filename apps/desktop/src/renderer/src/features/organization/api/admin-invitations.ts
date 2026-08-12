import { createOrganizationDataClient, type AuthenticatedOrganizationSession } from './client'
import { requestOrganizationCommand } from './command-client'

export interface PendingOrganizationInvitation {
  readonly id: string
  readonly email: string
  readonly expiresAt: string
}

export async function readPendingOrganizationInvitations(
  session: AuthenticatedOrganizationSession,
  organizationId: string
): Promise<readonly PendingOrganizationInvitation[]> {
  const { data, error } = await createOrganizationDataClient(session)
    .from('invitations')
    .select('id, email, expires_at, created_at')
    .eq('organization_id', organizationId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })

  if (error) throw new Error('Pending Organization Invitation request failed.')
  return data.map((row) => toPendingOrganizationInvitation(row))
}

export async function createOrganizationInvitation(
  session: AuthenticatedOrganizationSession,
  organizationId: string,
  email: string
): Promise<void> {
  const canonicalEmail = email.trim().toLowerCase()
  const response = await requestOrganizationCommand({
    accessToken: session.accessToken,
    method: 'POST',
    path: `/identity/organizations/${encodeURIComponent(organizationId)}/invitations`,
    body: { email: canonicalEmail }
  })
  validateInvitationCommandResponse(response, {
    organizationId,
    email: canonicalEmail,
    expectedStatus: 'pending'
  })
}

export async function resendOrganizationInvitation(
  session: AuthenticatedOrganizationSession,
  organizationId: string,
  invitationId: string
): Promise<void> {
  const response = await requestOrganizationCommand({
    accessToken: session.accessToken,
    method: 'POST',
    path: `/identity/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}/resend`,
    body: {}
  })
  validateInvitationCommandResponse(response, {
    organizationId,
    invitationId,
    expectedStatus: 'pending'
  })
}

export async function revokeOrganizationInvitation(
  session: AuthenticatedOrganizationSession,
  organizationId: string,
  invitationId: string
): Promise<void> {
  const response = await requestOrganizationCommand({
    accessToken: session.accessToken,
    method: 'POST',
    path: `/identity/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}/revoke`,
    body: {}
  })
  validateInvitationCommandResponse(response, {
    organizationId,
    invitationId,
    expectedStatus: 'revoked'
  })
}

function toPendingOrganizationInvitation(value: unknown): PendingOrganizationInvitation {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !('email' in value) ||
    !('expires_at' in value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.email !== 'string' ||
    value.email.length === 0 ||
    typeof value.expires_at !== 'string' ||
    Number.isNaN(Date.parse(value.expires_at))
  ) {
    throw new Error('Pending Organization Invitation response is invalid.')
  }

  return { id: value.id, email: value.email, expiresAt: value.expires_at }
}

function validateInvitationCommandResponse(
  value: unknown,
  expected: {
    readonly organizationId: string
    readonly invitationId?: string
    readonly email?: string
    readonly expectedStatus: 'pending' | 'revoked'
  }
): void {
  if (typeof value !== 'object' || value === null || !('invitation' in value)) {
    throw new Error('Organization Invitation command response is invalid.')
  }
  const invitation = value.invitation
  if (
    typeof invitation !== 'object' ||
    invitation === null ||
    !('id' in invitation) ||
    !('organization_id' in invitation) ||
    !('email' in invitation) ||
    !('status' in invitation) ||
    !('expires_at' in invitation) ||
    typeof invitation.id !== 'string' ||
    invitation.id.length === 0 ||
    (expected.invitationId !== undefined && invitation.id !== expected.invitationId) ||
    invitation.organization_id !== expected.organizationId ||
    typeof invitation.email !== 'string' ||
    invitation.email.length === 0 ||
    (expected.email !== undefined && invitation.email !== expected.email) ||
    invitation.status !== expected.expectedStatus ||
    typeof invitation.expires_at !== 'string' ||
    Number.isNaN(Date.parse(invitation.expires_at))
  ) {
    throw new Error('Organization Invitation command response is invalid.')
  }
}
