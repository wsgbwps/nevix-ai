import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { SupabasePublicConfig } from '../../../../../shared/config/supabase-public-config'

export function createAuthenticationClient(config: SupabasePublicConfig): SupabaseClient {
  return createClient(config.url, config.publishableKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: false,
      detectSessionInUrl: false
    }
  })
}
