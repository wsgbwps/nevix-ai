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

/**
 * The recovery subflow proves email control on a client that is deliberately isolated from the
 * authenticated Session owner: its Session lives only in this client's memory and is never
 * persisted, auto-refreshed, or published to the top-level authentication gate.
 */
export function createRecoveryClient(config: SupabasePublicConfig): SupabaseClient {
  return createClient(config.url, config.publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  })
}
