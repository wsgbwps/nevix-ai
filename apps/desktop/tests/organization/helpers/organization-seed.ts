import { Client } from 'pg'

export interface SeededOrganization {
  readonly id: string
  readonly name: string
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
