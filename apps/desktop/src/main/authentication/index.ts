import type {
  PersistedSessionRead,
  PersistedSessionWrite
} from '../../shared/ipc/authentication/types'
import {
  clearPersistedSession,
  readPersistedSession,
  replacePersistedSession
} from './session-store'

let currentSessionToken: string | null | undefined

export async function readCurrentSession(): Promise<PersistedSessionRead> {
  const stored = await readPersistedSession()
  if (stored.outcome === 'session') currentSessionToken = sessionToken(stored.session) ?? null
  if (stored.outcome === 'empty' || stored.outcome === 'unreadable') currentSessionToken = null
  return stored
}

export async function replaceCurrentSession(session: string): Promise<PersistedSessionWrite> {
  const result = await replacePersistedSession(session)
  currentSessionToken = sessionToken(session) ?? null
  return result
}

export async function clearCurrentSession(): Promise<void> {
  currentSessionToken = null
  await clearPersistedSession()
}

/** Returns only the current opaque token to trusted Main-process consumers. */
export async function readCurrentSessionToken(): Promise<string | undefined> {
  if (currentSessionToken !== undefined) return currentSessionToken ?? undefined
  const stored = await readCurrentSession()
  return stored.outcome === 'session' ? (currentSessionToken ?? undefined) : undefined
}

function sessionToken(session: string): string | undefined {
  try {
    const token = (JSON.parse(session) as { token?: unknown }).token
    return typeof token === 'string' && token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}
