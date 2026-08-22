import { app, safeStorage } from 'electron'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  PersistedSessionRead,
  PersistedSessionWrite
} from '../../shared/ipc/authentication/types'

const SESSION_FILE_NAME = 'authentication-session.enc'
const ENVELOPE_VERSION = 1
const MAXIMUM_SESSION_LENGTH = 64 * 1024
const MAXIMUM_ENVELOPE_LENGTH = 128 * 1024

export async function readPersistedSession(): Promise<PersistedSessionRead> {
  let envelope: string

  try {
    envelope = await readFile(sessionPath(), 'utf8')
  } catch (error) {
    // A read failure is not structural corruption: the envelope may still hold a valid Session, so
    // it must not be deleted. The renderer retry boundary re-reads the store once the file system
    // recovers, so this mirrors the outage outcome without touching the envelope.
    return isMissingFile(error) ? { outcome: 'empty' } : { outcome: 'storage-unavailable' }
  }

  if (envelope.length > MAXIMUM_ENVELOPE_LENGTH) return discardUnreadableSession()

  const ciphertext = readEnvelopeCiphertext(envelope)
  if (!ciphertext) return discardUnreadableSession()

  // A structurally valid envelope may hold intact ciphertext, so an unavailable backend is
  // recoverable; only structural corruption above is terminal even during an outage.
  if (!canPersistSecurely()) return { outcome: 'storage-unavailable' }

  let storedSession: string
  try {
    storedSession = safeStorage.decryptString(ciphertext)
  } catch {
    return discardUnreadableSession()
  }

  const session = canonicalizeSession(storedSession)
  if (!session) return discardUnreadableSession()

  // Supabase-era sessions no longer match the canonical schema and were discarded above; a
  // decryptable session that merely carries extra fields is rewritten to the strict
  // Authentication-owned schema as soon as it is successfully decrypted.
  if (session !== storedSession) {
    const rewrite = await replacePersistedSession(session)
    if (rewrite.outcome === 'unavailable') return { outcome: 'storage-unavailable' }
  }
  return { outcome: 'session', session }
}

export async function replacePersistedSession(session: string): Promise<PersistedSessionWrite> {
  const canonicalSession = canonicalizeSession(session)
  if (!canonicalSession) throw new Error('Session storage received an invalid Session payload')
  if (!canPersistSecurely()) return { outcome: 'unavailable' }
  const path = sessionPath()
  const pendingPath = `${path}.pending`

  try {
    const envelope = JSON.stringify({
      version: ENVELOPE_VERSION,
      ciphertext: safeStorage.encryptString(canonicalSession).toString('base64')
    })

    await mkdir(dirname(path), { recursive: true })
    await writeFile(pendingPath, envelope, { encoding: 'utf8', mode: 0o600 })
    await rename(pendingPath, path)
    return { outcome: 'persisted' }
  } catch {
    // The atomic rename means a failed write never corrupts the existing envelope, so only the
    // pending file is removed: the last good ciphertext keeps restoring, and nothing downgrades
    // to plaintext persistence.
    await rm(pendingPath, { force: true }).catch(() => undefined)
    return { outcome: 'unavailable' }
  }
}

export async function clearPersistedSession(): Promise<void> {
  const path = sessionPath()
  await Promise.all([rm(path, { force: true }), rm(`${path}.pending`, { force: true })])
}

function canPersistSecurely(): boolean {
  if (isSecureStorageUnavailableForTest()) return false
  if (
    process.platform === 'linux' &&
    process.env.NEVIX_E2E === '1' &&
    !app.isPackaged &&
    process.env.NEVIX_TEST_FORCE_BASIC_TEXT_STORAGE === '1'
  ) {
    safeStorage.setUsePlainTextEncryption(true)
  }
  if (!safeStorage.isEncryptionAvailable()) return false

  // Electron's Linux fallback derives a key from a hard-coded password, so it is not encryption.
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

function isSecureStorageUnavailableForTest(): boolean {
  return (
    process.env.NEVIX_E2E === '1' &&
    !app.isPackaged &&
    process.env.NEVIX_TEST_UNAVAILABLE_SECURE_STORAGE === '1'
  )
}

function readEnvelopeCiphertext(envelope: string): Buffer | undefined {
  try {
    const parsed: unknown = JSON.parse(envelope)
    if (typeof parsed !== 'object' || parsed === null) return undefined

    const { version, ciphertext } = parsed as { version?: unknown; ciphertext?: unknown }
    if (
      version !== ENVELOPE_VERSION ||
      typeof ciphertext !== 'string' ||
      ciphertext.length === 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext) ||
      ciphertext.length % 4 !== 0
    ) {
      return undefined
    }

    return Buffer.from(ciphertext, 'base64')
  } catch {
    return undefined
  }
}

function canonicalizeSession(session: string): string | undefined {
  if (session.length === 0 || session.length > MAXIMUM_SESSION_LENGTH) return undefined

  try {
    const parsed: unknown = JSON.parse(session)
    if (typeof parsed !== 'object' || parsed === null) return undefined

    const {
      token,
      expires_at: expiresAt,
      user
    } = parsed as {
      token?: unknown
      expires_at?: unknown
      user?: unknown
    }
    const userId =
      typeof user === 'object' && user !== null ? (user as { id?: unknown }).id : undefined
    const userEmail =
      typeof user === 'object' && user !== null ? (user as { email?: unknown }).email : undefined

    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      typeof expiresAt !== 'string' ||
      Number.isNaN(Date.parse(expiresAt)) ||
      typeof userId !== 'string' ||
      userId.length === 0 ||
      typeof userEmail !== 'string' ||
      userEmail.length === 0
    ) {
      return undefined
    }

    // The canonical Authentication-owned schema: the opaque token, its server-computed
    // expiry, and the account snapshot the login response carried.
    return JSON.stringify({
      token,
      expires_at: expiresAt,
      user: { id: userId, email: userEmail }
    })
  } catch {
    return undefined
  }
}

async function discardUnreadableSession(): Promise<PersistedSessionRead> {
  await clearPersistedSession().catch(() => undefined)
  return { outcome: 'unreadable' }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function sessionPath(): string {
  return join(app.getPath('userData'), SESSION_FILE_NAME)
}
