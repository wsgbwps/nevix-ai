import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { parseSupabasePublicConfig } from '../../../../../shared/config/supabase-public-config'

export interface AuthenticatedOrganizationSession {
  readonly accessToken: string
  readonly userId: string
  readonly email: string
}

/**
 * Builds the Organization Domain's short-lived Data API client. Every direct
 * read remains authenticated by the current Session and protected by RLS.
 */
export function createOrganizationDataClient(
  session: AuthenticatedOrganizationSession
): SupabaseClient {
  const config = parseSupabasePublicConfig({
    url: __NEVIX_SUPABASE_URL__,
    publishableKey: __NEVIX_SUPABASE_PUBLISHABLE_KEY__,
    policy: __NEVIX_SUPABASE_CONFIG_POLICY__
  })
  if (!config) throw new Error('Organization configuration is unavailable.')

  return createClient(config.url, config.publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    },
    accessToken: async () => session.accessToken
  })
}
