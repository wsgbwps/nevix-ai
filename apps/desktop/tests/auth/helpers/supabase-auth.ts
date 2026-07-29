import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'

interface AuthHarnessConfig {
  readonly url: string
  readonly publishableKey: string
  readonly serviceRoleKey: string
}

export function readAuthHarnessConfig(): AuthHarnessConfig | undefined {
  const url = process.env.NEVIX_TEST_SUPABASE_URL
  const publishableKey = process.env.NEVIX_TEST_SUPABASE_PUBLISHABLE_KEY
  const serviceRoleKey = process.env.NEVIX_TEST_SUPABASE_SERVICE_ROLE_KEY

  if (!url || !publishableKey || !serviceRoleKey) return undefined
  return { url, publishableKey, serviceRoleKey }
}

export function uniqueAuthIdentity(label: string): {
  readonly email: string
  readonly password: string
} {
  const suffix = `${Date.now()}-${crypto.randomUUID()}`
  return {
    email: `${label}-${suffix}@nevix.test`,
    password: `Nevix test password ${suffix}`
  }
}

function createHarnessClient(config: AuthHarnessConfig, key: string): SupabaseClient {
  return createClient(config.url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  })
}

export async function createAuthUser(
  config: AuthHarnessConfig,
  identity: { readonly email: string; readonly password: string },
  emailConfirmed: boolean
): Promise<string> {
  const adminClient = createHarnessClient(config, config.serviceRoleKey)
  const { data, error } = await adminClient.auth.admin.createUser({
    email: identity.email,
    password: identity.password,
    email_confirm: emailConfirmed
  })

  if (error) throw new Error(`Unable to create Auth test User: ${error.code}`)
  return data.user.id
}

export async function deleteAuthUser(config: AuthHarnessConfig, userId: string): Promise<void> {
  const adminClient = createHarnessClient(config, config.serviceRoleKey)
  const { error } = await adminClient.auth.admin.deleteUser(userId)
  if (error) throw new Error(`Unable to delete Auth test User: ${error.code}`)
}

export async function signInOutsideDesktop(
  config: AuthHarnessConfig,
  identity: { readonly email: string; readonly password: string }
): Promise<Session> {
  const client = createHarnessClient(config, config.publishableKey)
  const { data, error } = await client.auth.signInWithPassword(identity)
  if (error || !data.session) {
    throw new Error(`Unable to sign in Auth test User: ${error?.code ?? 'missing_session'}`)
  }
  return data.session
}

export async function refreshOutsideDesktop(
  config: AuthHarnessConfig,
  refreshToken: string
): Promise<Session> {
  const client = createHarnessClient(config, config.publishableKey)
  const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken })
  if (error || !data.session) {
    throw new Error(`Unable to refresh Auth test Session: ${error?.code ?? 'missing_session'}`)
  }
  return data.session
}
