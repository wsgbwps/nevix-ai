import { readServerPublicConfig } from '../../../lib/server-public-config'

/** The minimum a Profile call needs from the current session: the opaque token. */
export interface AuthenticatedProfileSession {
  readonly token: string
}

export interface Profile {
  readonly displayName: string
}

/**
 * Reads the account's display name from the trusted data plane. `undefined` means
 * the server answer could not be read as an account; callers treat it as a load failure.
 */
export async function readProfile(session: AuthenticatedProfileSession): Promise<Profile> {
  const user = await requestMe(session)
  return { displayName: user.display_name }
}

export async function saveProfile(
  session: AuthenticatedProfileSession,
  displayName: string
): Promise<Profile> {
  const config = readServerPublicConfig()
  if (!config) throw new Error('Server configuration is unavailable.')

  const response = await fetch(new URL('/identity/users/me', config.url), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`
    },
    body: JSON.stringify({ display_name: displayName })
  })

  const payload = await readJson(response).catch(() => undefined)
  if (!response.ok || payload === undefined) {
    throw new Error('Profile request failed.')
  }

  const user = (payload as { user?: unknown }).user
  if (typeof user !== 'object' || user === null) throw new Error('Profile response is invalid.')

  const saved = (user as { display_name?: unknown }).display_name
  if (typeof saved !== 'string') throw new Error('Profile response is invalid.')

  return { displayName: saved }
}

async function requestMe(session: AuthenticatedProfileSession): Promise<{
  readonly display_name: string
}> {
  const config = readServerPublicConfig()
  if (!config) throw new Error('Server configuration is unavailable.')

  const response = await fetch(new URL('/identity/users/me', config.url), {
    headers: { Authorization: `Bearer ${session.token}` }
  })

  const payload = await readJson(response).catch(() => undefined)
  if (!response.ok || payload === undefined) {
    throw new Error('Profile request failed.')
  }

  const user = (payload as { user?: unknown }).user
  if (typeof user !== 'object' || user === null) throw new Error('Profile response is invalid.')

  const displayName = (user as { display_name?: unknown }).display_name
  if (typeof displayName !== 'string') throw new Error('Profile response is invalid.')

  return { display_name: displayName }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json()
}
