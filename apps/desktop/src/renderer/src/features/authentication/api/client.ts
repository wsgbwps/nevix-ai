import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { AUTHENTICATION_STORAGE_KEY, persistedSessionStorage } from '../session/persisted-session'
import type { SupabasePublicConfig } from '../../../../../shared/config/supabase-public-config'

export function createAuthenticationClient(config: SupabasePublicConfig): SupabaseClient {
  return createClient(config.url, config.publishableKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      storageKey: AUTHENTICATION_STORAGE_KEY,
      storage: persistedSessionStorage
    }
  })
}
