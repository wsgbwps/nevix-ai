import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { parseSupabasePublicConfig } from '../../../../../shared/config/supabase-public-config'

export interface AuthenticatedProfileSession {
  readonly accessToken: string
  readonly userId: string
}

export interface Profile {
  readonly displayName: string
}

export async function readProfile(
  session: AuthenticatedProfileSession
): Promise<Profile | undefined> {
  const { data, error } = await profileClient(session)
    .from('profiles')
    .select('user_id, display_name')
    .eq('user_id', session.userId)
    .maybeSingle()

  if (error) throw new Error('Profile request failed.')
  if (data === null) return undefined

  return toProfile(data, session.userId)
}

export async function hasCompletedProfile(session: AuthenticatedProfileSession): Promise<boolean> {
  return (await readProfile(session)) !== undefined
}

export async function saveProfile(
  session: AuthenticatedProfileSession,
  displayName: string
): Promise<Profile> {
  const { data, error } = await profileClient(session)
    .from('profiles')
    .upsert(
      {
        user_id: session.userId,
        display_name: displayName
      },
      { onConflict: 'user_id' }
    )
    .select('user_id, display_name')
    .single()

  if (error) throw new Error('Profile request failed.')
  return toProfile(data, session.userId)
}

function profileClient(session: AuthenticatedProfileSession): SupabaseClient {
  const config = parseSupabasePublicConfig({
    url: __NEVIX_SUPABASE_URL__,
    publishableKey: __NEVIX_SUPABASE_PUBLISHABLE_KEY__,
    policy: __NEVIX_SUPABASE_CONFIG_POLICY__
  })
  if (!config) throw new Error('Profile configuration is unavailable.')

  return createClient(config.url, config.publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    },
    accessToken: async () => session.accessToken
  })
}

function toProfile(value: unknown, userId: string): Profile {
  if (typeof value !== 'object' || value === null) throw new Error('Profile response is invalid.')

  const row = value as { user_id?: unknown; display_name?: unknown }
  if (row.user_id !== userId || typeof row.display_name !== 'string') {
    throw new Error('Profile response is invalid.')
  }

  return { displayName: row.display_name }
}
