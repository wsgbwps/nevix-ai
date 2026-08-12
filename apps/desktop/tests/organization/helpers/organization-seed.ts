import { Client } from 'pg'

export interface SeededOrganization {
  readonly id: string
  readonly name: string
}

export interface AuditLogSeed {
  readonly actorUserId: string
  readonly actorDisplayName: string
  readonly targetUserId?: string
  readonly targetDisplayName?: string
  readonly action: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly createdAt?: string
}

export interface InvitationAcceptanceState {
  readonly displayName: string | undefined
  readonly invitationStatus: string | undefined
  readonly organizations: readonly {
    readonly id: string
    readonly name: string
    readonly role: string
    readonly status: string
  }[]
}

/**
 * Seeds Organizations and Memberships through the stack's trusted `identity_app` role. Profile
 * fixtures use the harness database owner because `identity_app` is SELECT-only on profiles by
 * design; production Profile writes remain authenticated RLS client operations.
 */
async function withIdentityAppClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  return withDatabaseClient(async (client) => {
    await client.query('SET ROLE identity_app')
    return run(client)
  })
}

async function withDatabaseClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const databaseUrl = process.env.NEVIX_TEST_DATABASE_URL
  if (!databaseUrl) {
    throw new Error(
      'NEVIX_TEST_DATABASE_URL is missing; run the E2E Suite through scripts/run-e2e.sh'
    )
  }

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    return await run(client)
  } finally {
    await client.end()
  }
}

export async function seedProfile(userId: string, displayName = 'E2E User'): Promise<void> {
  await withDatabaseClient(async (client) => {
    await client.query(
      'INSERT INTO profiles (user_id, display_name) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
      [userId, displayName]
    )
  })
}

export async function seedOrganizationWithMembership(
  userId: string,
  options: {
    readonly name: string
    readonly role?: 'owner' | 'admin' | 'member'
    readonly profileDisplayName?: string
  }
): Promise<SeededOrganization> {
  const id = crypto.randomUUID()
  await seedProfile(userId, options.profileDisplayName)

  return withIdentityAppClient(async (client) => {
    await client.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [id, options.name])
    await client.query(
      'INSERT INTO memberships (organization_id, user_id, role, status) VALUES ($1, $2, $3, $4)',
      [id, userId, options.role ?? 'owner', 'active']
    )
    return { id, name: options.name }
  })
}

export async function seedActiveMembership(
  organizationId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member'
): Promise<void> {
  await withIdentityAppClient(async (client) => {
    await client.query(
      'INSERT INTO memberships (organization_id, user_id, role, status) VALUES ($1, $2, $3, $4)',
      [organizationId, userId, role, 'active']
    )
  })
}

export async function updateMembershipRole(
  userId: string,
  organizationId: string,
  role: 'owner' | 'admin' | 'member'
): Promise<void> {
  await withIdentityAppClient(async (client) => {
    const result = await client.query(
      "UPDATE memberships SET role = $3 WHERE user_id = $1 AND organization_id = $2 AND status = 'active'",
      [userId, organizationId, role]
    )
    if (result.rowCount === 0) {
      throw new Error('Unable to update test Membership role: no active Membership found')
    }
  })
}

export async function endMembership(userId: string, organizationId: string): Promise<void> {
  await withIdentityAppClient(async (client) => {
    const result = await client.query(
      "UPDATE memberships SET status = 'ended' WHERE user_id = $1 AND organization_id = $2 AND status = 'active'",
      [userId, organizationId]
    )
    if (result.rowCount === 0) {
      throw new Error('Unable to end test Membership: no active Membership found')
    }
  })
}

/**
 * Seeds immutable Audit Log snapshots through the trusted identity_app role. The Desktop reads
 * these rows through the same RLS-protected Data API seam used in production.
 */
export async function seedAuditLogEntries(
  organizationId: string,
  entries: readonly AuditLogSeed[]
): Promise<void> {
  await withIdentityAppClient(async (client) => {
    for (const entry of entries) {
      await client.query(
        `INSERT INTO audit_logs (
          organization_id, actor_user_id, actor_display_name,
          target_user_id, target_display_name, action, metadata, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          organizationId,
          entry.actorUserId,
          entry.actorDisplayName,
          entry.targetUserId ?? null,
          entry.targetDisplayName ?? null,
          entry.action,
          JSON.stringify(entry.metadata ?? {}),
          entry.createdAt ?? new Date().toISOString()
        ]
      )
    }
  })
}

export async function readPendingInvitationId(
  organizationId: string,
  email: string
): Promise<string> {
  return withIdentityAppClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id
       FROM invitations
       WHERE organization_id = $1 AND email = $2 AND status = 'pending'`,
      [organizationId, email]
    )
    if (result.rows.length !== 1) {
      throw new Error('Expected exactly one pending invitation')
    }
    return result.rows[0].id
  })
}

export async function ageInvitationCodeBeyondCooldown(invitationId: string): Promise<void> {
  await withIdentityAppClient(async (client) => {
    const result = await client.query(
      `UPDATE identity.verification_codes
       SET created_at = clock_timestamp() - interval '2 minutes'
       WHERE target_id = $1 AND action_type = 'invitation'`,
      [invitationId]
    )
    if (result.rowCount !== 1) {
      throw new Error('Unable to age the invitation code beyond the resend cooldown')
    }
  })
}

export async function expireInvitation(invitationId: string): Promise<void> {
  await withIdentityAppClient(async (client) => {
    const invitation = await client.query(
      "UPDATE invitations SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [invitationId]
    )
    if (invitation.rowCount !== 1) throw new Error('Unable to expire the test invitation')

    const code = await client.query(
      `UPDATE identity.verification_codes
       SET expires_at = clock_timestamp() - interval '1 second'
       WHERE target_id = $1 AND action_type = 'invitation'`,
      [invitationId]
    )
    if (code.rowCount !== 1) throw new Error('Unable to expire the test invitation code')
  })
}

export async function readInvitationAcceptanceState(
  userId: string,
  invitationId: string
): Promise<InvitationAcceptanceState> {
  return withIdentityAppClient(async (client) => {
    const profile = await client.query<{ display_name: string }>(
      'SELECT display_name FROM profiles WHERE user_id = $1',
      [userId]
    )
    const invitation = await client.query<{ status: string }>(
      'SELECT status FROM invitations WHERE id = $1',
      [invitationId]
    )
    const organizations = await client.query<{
      organization_id: string
      organization_name: string
      role: string
      status: string
    }>(
      `SELECT organizations.id AS organization_id,
              organizations.name AS organization_name,
              memberships.role,
              memberships.status
       FROM memberships
       JOIN organizations ON organizations.id = memberships.organization_id
       WHERE memberships.user_id = $1
       ORDER BY organizations.id`,
      [userId]
    )

    return {
      displayName: profile.rows[0]?.display_name,
      invitationStatus: invitation.rows[0]?.status,
      organizations: organizations.rows.map((row) => ({
        id: row.organization_id,
        name: row.organization_name,
        role: row.role,
        status: row.status
      }))
    }
  })
}
