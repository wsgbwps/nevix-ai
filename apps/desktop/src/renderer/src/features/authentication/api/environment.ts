import {
  parseSupabasePublicConfig,
  type SupabasePublicConfig
} from '../../../../../shared/config/supabase-public-config'

export function readSupabasePublicConfig(): SupabasePublicConfig | undefined {
  return parseSupabasePublicConfig({
    url: __NEVIX_SUPABASE_URL__,
    publishableKey: __NEVIX_SUPABASE_PUBLISHABLE_KEY__,
    policy: __NEVIX_SUPABASE_CONFIG_POLICY__
  })
}
