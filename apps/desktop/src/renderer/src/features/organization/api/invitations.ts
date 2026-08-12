import { readServerPublicConfig } from '../../../lib/server-public-config'
import { createOrganizationDataClient, type AuthenticatedOrganizationSession } from './client'

export interface PendingInvitation {
  readonly id: string
  readonly organizationName: string | undefined
  readonly inviterDisplayName: string | undefined
}

export interface AcceptInvitationInput {
  readonly session: AuthenticatedOrganizationSession
  readonly invitationId: string
  readonly code: string
}

export interface AcceptedInvitation {
  readonly organizationId: string
}

/**
 * Keeps the command's stable machine code and its optional authoritative
 * attempt count separate from localized UI copy.
 */
export class InvitationAcceptanceError extends Error {
  readonly code: string
  readonly attemptsRemaining: number | undefined

  constructor(code: string, message: string, attemptsRemaining: number | undefined) {
    super(message)
    this.name = 'InvitationAcceptanceError'
    this.code = code
    this.attemptsRemaining = attemptsRemaining
  }
}

/**
 * Pending invitations are the only invitations an invitee can read under the
 * email RLS policy. Their name snapshots avoid widening Organization/Profile
 * visibility before acceptance.
 */
export async function readPendingInvitations(
  session: AuthenticatedOrganizationSession
): Promise<readonly PendingInvitation[]> {
  const { data, error } = await createOrganizationDataClient(session)
    .from('invitations')
    .select('id, organization_name, inviter_display_name')
    .eq('status', 'pending')
    .eq('email', session.email)

  if (error) throw new Error('Pending invitation request failed.')
  return data.map((row) => toPendingInvitation(row))
}

export async function acceptInvitation({
  session,
  invitationId,
  code
}: AcceptInvitationInput): Promise<AcceptedInvitation> {
  const config = readServerPublicConfig()
  if (!config) throw new Error('Server configuration is unavailable.')

  const response = await fetch(
    new URL(`/identity/invitations/${encodeURIComponent(invitationId)}/accept`, config.url),
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ code })
    }
  )

  if (!response.ok) throw await toAcceptanceError(response)

  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) {
    throw new Error('Invitation acceptance response is invalid.')
  }
  const membership = (body as { membership?: unknown }).membership
  if (typeof membership !== 'object' || membership === null) {
    throw new Error('Invitation acceptance response is invalid.')
  }
  const organizationId = (membership as { organization_id?: unknown }).organization_id
  if (typeof organizationId !== 'string' || organizationId.length === 0) {
    throw new Error('Invitation acceptance response is invalid.')
  }
  return { organizationId }
}

function toPendingInvitation(value: unknown): PendingInvitation {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Pending invitation response is invalid.')
  }

  const row = value as {
    id?: unknown
    organization_name?: unknown
    inviter_display_name?: unknown
  }
  if (typeof row.id !== 'string') {
    throw new Error('Pending invitation response is invalid.')
  }
  if (
    row.organization_name !== null &&
    row.organization_name !== undefined &&
    typeof row.organization_name !== 'string'
  ) {
    throw new Error('Pending invitation response is invalid.')
  }
  if (
    row.inviter_display_name !== null &&
    row.inviter_display_name !== undefined &&
    typeof row.inviter_display_name !== 'string'
  ) {
    throw new Error('Pending invitation response is invalid.')
  }

  return {
    id: row.id,
    organizationName: row.organization_name ?? undefined,
    inviterDisplayName: row.inviter_display_name ?? undefined
  }
}

async function toAcceptanceError(response: Response): Promise<InvitationAcceptanceError> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }

  const error = body as { error?: unknown; message?: unknown } | undefined
  const code = typeof error?.error === 'string' ? error.error : 'invitation_acceptance_failed'
  const message =
    typeof error?.message === 'string' ? error.message : 'Invitation acceptance request failed.'
  return new InvitationAcceptanceError(
    code,
    message,
    parseAttemptsRemaining(response.headers.get('X-Invitation-Code-Attempts-Remaining'))
  )
}

function parseAttemptsRemaining(value: string | null): number | undefined {
  if (value === null || !/^[0-4]$/.test(value)) return undefined
  return Number(value)
}
