import { app, safeStorage } from 'electron'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

type RememberedEmailReadResult =
  | {
      readonly outcome: 'email'
      readonly email: string
      readonly persistence: 'secure' | 'memory-only'
    }
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'storage-unavailable' }

interface RememberedEmailWriteResult {
  readonly outcome: 'persisted' | 'memory-only'
}

interface RememberedEmailClearResult {
  readonly outcome: 'cleared' | 'clear-failed'
}

const REMEMBERED_EMAIL_FILE_NAME = 'authentication-remembered-email.enc'
const ENVELOPE_VERSION = 1
const MAXIMUM_EMAIL_BYTES = 320
const MAXIMUM_ENVELOPE_LENGTH = 8 * 1024

let rememberedEmailInMemory: string | null | undefined
let persistenceUnavailable = false

export async function readRememberedEmail(): Promise<RememberedEmailReadResult> {
  if (rememberedEmailInMemory !== undefined) return currentMemoryResult()

  let envelope: string
  try {
    envelope = await readFile(rememberedEmailPath(), 'utf8')
  } catch (error) {
    if (!isMissingFile(error)) {
      rememberedEmailInMemory = null
      persistenceUnavailable = true
      return { outcome: 'storage-unavailable' }
    }

    rememberedEmailInMemory = null
    persistenceUnavailable = !canPersistSecurely()
    return currentMemoryResult()
  }

  if (envelope.length > MAXIMUM_ENVELOPE_LENGTH) return discardInvalidRecord()

  const ciphertext = readEnvelopeCiphertext(envelope)
  if (!ciphertext) return discardInvalidRecord()

  if (!canPersistSecurely()) {
    rememberedEmailInMemory = null
    persistenceUnavailable = true
    return { outcome: 'storage-unavailable' }
  }

  try {
    const email = safeStorage.decryptString(ciphertext)
    if (!isUsableRememberedEmail(email)) return discardInvalidRecord()

    rememberedEmailInMemory = email
    persistenceUnavailable = false
    return { outcome: 'email', email, persistence: 'secure' }
  } catch {
    return discardInvalidRecord()
  }
}

export async function replaceRememberedEmail(email: string): Promise<RememberedEmailWriteResult> {
  if (!isUsableRememberedEmail(email)) {
    throw new Error('Remembered Email storage received an unusable email')
  }

  rememberedEmailInMemory = email
  if (!canPersistSecurely()) {
    persistenceUnavailable = true
    return { outcome: 'memory-only' }
  }

  const path = rememberedEmailPath()
  const pendingPath = `${path}.pending`

  try {
    if (shouldFailEncryptionForTest()) throw new Error('Injected encryption failure')
    const envelope = JSON.stringify({
      version: ENVELOPE_VERSION,
      ciphertext: safeStorage.encryptString(email).toString('base64')
    })

    await mkdir(dirname(path), { recursive: true })
    await writeFile(pendingPath, envelope, { encoding: 'utf8', mode: 0o600 })
    await rename(pendingPath, path)
    persistenceUnavailable = false
    return { outcome: 'persisted' }
  } catch {
    await rm(pendingPath, { force: true }).catch(() => undefined)
    persistenceUnavailable = true
    return { outcome: 'memory-only' }
  }
}

export async function clearRememberedEmail(): Promise<RememberedEmailClearResult> {
  rememberedEmailInMemory = null
  if (await removeRememberedEmailFiles()) {
    persistenceUnavailable = false
    return { outcome: 'cleared' }
  }

  persistenceUnavailable = true
  return { outcome: 'clear-failed' }
}

function currentMemoryResult(): RememberedEmailReadResult {
  if (rememberedEmailInMemory) {
    return {
      outcome: 'email',
      email: rememberedEmailInMemory,
      persistence: persistenceUnavailable ? 'memory-only' : 'secure'
    }
  }
  return persistenceUnavailable ? { outcome: 'storage-unavailable' } : { outcome: 'empty' }
}

async function discardInvalidRecord(): Promise<RememberedEmailReadResult> {
  rememberedEmailInMemory = null
  const removed = await removeRememberedEmailFiles()
  console.warn('Remembered Email storage discarded an invalid encrypted record.')
  persistenceUnavailable = !removed || !canPersistSecurely()
  return currentMemoryResult()
}

async function removeRememberedEmailFiles(): Promise<boolean> {
  const path = rememberedEmailPath()
  const results = await Promise.allSettled([
    rm(path, { force: true }),
    rm(`${path}.pending`, { force: true })
  ])
  return results.every((result) => result.status === 'fulfilled')
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
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

function isSecureStorageUnavailableForTest(): boolean {
  return (
    process.env.NEVIX_E2E === '1' &&
    !app.isPackaged &&
    process.env.NEVIX_TEST_UNAVAILABLE_SECURE_STORAGE === '1'
  )
}

function shouldFailEncryptionForTest(): boolean {
  return (
    process.env.NEVIX_E2E === '1' &&
    !app.isPackaged &&
    process.env.NEVIX_TEST_FAIL_REMEMBERED_EMAIL_ENCRYPTION === '1'
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

function isUsableRememberedEmail(email: string): boolean {
  return (
    Buffer.byteLength(email, 'utf8') > 0 &&
    Buffer.byteLength(email, 'utf8') <= MAXIMUM_EMAIL_BYTES &&
    email.trim() === email &&
    /^[^\s@]+@[^\s@]+$/.test(email)
  )
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function rememberedEmailPath(): string {
  return join(app.getPath('userData'), REMEMBERED_EMAIL_FILE_NAME)
}
