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
    return isMissingFile(error) ? { outcome: 'empty' } : { outcome: 'unreadable' }
  }

  if (envelope.length > MAXIMUM_ENVELOPE_LENGTH) return { outcome: 'unreadable' }

  const ciphertext = readEnvelopeCiphertext(envelope)
  if (!ciphertext || !canPersistSecurely()) return { outcome: 'unreadable' }

  try {
    const session = safeStorage.decryptString(ciphertext)
    return hasSessionShape(session) ? { outcome: 'session', session } : { outcome: 'unreadable' }
  } catch {
    return { outcome: 'unreadable' }
  }
}

export async function replacePersistedSession(session: string): Promise<PersistedSessionWrite> {
  if (!canPersistSecurely()) {
    await clearPersistedSession().catch(() => undefined)
    return { outcome: 'unavailable' }
  }

  const path = sessionPath()
  const pendingPath = `${path}.pending`

  try {
    const envelope = JSON.stringify({
      version: ENVELOPE_VERSION,
      ciphertext: safeStorage.encryptString(session).toString('base64')
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
  await rm(path, { force: true })
  await rm(`${path}.pending`, { force: true })
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

function hasSessionShape(session: string): boolean {
  if (session.length === 0 || session.length > MAXIMUM_SESSION_LENGTH) return false

  try {
    const parsed: unknown = JSON.parse(session)
    if (typeof parsed !== 'object' || parsed === null) return false

    const {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: tokenType,
      expires_at: expiresAt,
      user
    } = parsed as {
      access_token?: unknown
      refresh_token?: unknown
      token_type?: unknown
      expires_at?: unknown
      user?: unknown
    }
    const userId =
      typeof user === 'object' && user !== null ? (user as { id?: unknown }).id : undefined

    return (
      typeof accessToken === 'string' &&
      accessToken.length > 0 &&
      typeof refreshToken === 'string' &&
      refreshToken.length > 0 &&
      typeof tokenType === 'string' &&
      tokenType.length > 0 &&
      typeof expiresAt === 'number' &&
      Number.isFinite(expiresAt) &&
      expiresAt > 0 &&
      typeof userId === 'string' &&
      userId.length > 0
    )
  } catch {
    return false
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function sessionPath(): string {
  return join(app.getPath('userData'), SESSION_FILE_NAME)
}
