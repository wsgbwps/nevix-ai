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

/**
 * Seeds Organizations and Memberships through the stack's trusted `identity_app` role: clients
 * are SELECT-only on these tables by design (ADR-0008), so tests arrange startup fixtures with
 * the same trusted seam the Go identity server writes through, reached over a direct database
 * connection supplied by the E2E runner.
 */
async function withIdentityAppClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const databaseUrl = process.env.NEVIX_TEST_DATABASE_URL
  if (!databaseUrl) {
    throw new Error(
      'NEVIX_TEST_DATABASE_URL is missing; run the E2E Suite through scripts/run-e2e.sh'
    )
  }

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query('SET ROLE identity_app')
    return await run(client)
  } finally {
    await client.end()
  }
}

export async function seedOrganizationWithMembership(
  userId: string,
  options: { readonly name: string; readonly role?: 'owner' | 'admin' | 'member' }
): Promise<SeededOrganization> {
  const id = crypto.randomUUID()

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
