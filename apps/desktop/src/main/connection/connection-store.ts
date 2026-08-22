import { app } from 'electron'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sanitizeCertificatePins } from './certificate-pins'
import { parseServerUrl } from '../../shared/config/server-url'
import type {
  ServerConnectionRead,
  ServerConnectionSaveResult,
  ServerConnectionTrustResult
} from '../../shared/ipc/connection/types'

const CONNECTION_FILE_NAME = 'server-connection.json'
const ENVELOPE_VERSION = 1
const MAXIMUM_FILE_LENGTH = 64 * 1024

/**
 * The runtime mirror of the persisted server connection: the certificate
 * verify proc and the renderer CSP injection read it synchronously, while
 * every mutation goes through the validated, atomically-written store.
 */
interface ConnectionRuntime {
  url: string | undefined
  certificatePins: ReadonlyMap<string, string>
}

const runtime: ConnectionRuntime = { url: undefined, certificatePins: new Map() }

export function currentServerConnectionUrl(): string | undefined {
  return runtime.url
}

export function currentCertificatePins(): ReadonlyMap<string, string> {
  return runtime.certificatePins
}

export async function readServerConnection(): Promise<ServerConnectionRead> {
  await loadIntoRuntime()
  return runtime.url === undefined
    ? { state: 'unconfigured' }
    : { state: 'configured', url: runtime.url }
}

export async function saveServerConnectionUrl(url: string): Promise<ServerConnectionSaveResult> {
  const canonicalUrl = parseServerUrl(url)
  if (!canonicalUrl) return { outcome: 'invalid-url' }

  const write = await persist({ url: canonicalUrl, certificatePins: runtime.certificatePins })
  if (write !== 'persisted') return { outcome: 'unavailable' }

  runtime.url = canonicalUrl
  return { outcome: 'saved' }
}

export async function trustServerCertificate(
  url: string,
  fingerprint: string
): Promise<ServerConnectionTrustResult> {
  const canonicalUrl = parseServerUrl(url)
  if (!canonicalUrl || new URL(canonicalUrl).protocol !== 'https:') {
    return { outcome: 'invalid-url' }
  }
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) return { outcome: 'invalid-url' }

  const pins = new Map(runtime.certificatePins)
  pins.set(new URL(canonicalUrl).hostname, fingerprint)
  const persistFrom = runtime.url === undefined ? { url: undefined } : { url: runtime.url }
  const write = await persist({ ...persistFrom, certificatePins: pins })
  if (write !== 'persisted') return { outcome: 'unavailable' }

  runtime.certificatePins = pins
  return { outcome: 'trusted' }
}

type PersistOutcome = 'persisted' | 'unavailable'

interface PersistableConnection {
  readonly url: string | undefined
  readonly certificatePins: ReadonlyMap<string, string>
}

async function persist(connection: PersistableConnection): Promise<PersistOutcome> {
  const path = connectionPath()
  const pendingPath = `${path}.pending`
  const envelope = JSON.stringify({
    version: ENVELOPE_VERSION,
    ...(connection.url === undefined ? {} : { url: connection.url }),
    certificatePins: Object.fromEntries(connection.certificatePins)
  })

  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(pendingPath, envelope, { encoding: 'utf8', mode: 0o600 })
    await rename(pendingPath, path)
    return 'persisted'
  } catch {
    // The atomic rename means a failed write never corrupts the existing file:
    // only the pending file is removed and the last good connection keeps loading.
    await rm(pendingPath, { force: true }).catch(() => undefined)
    return 'unavailable'
  }
}

async function loadIntoRuntime(): Promise<void> {
  let contents: string
  try {
    contents = await readFile(connectionPath(), 'utf8')
  } catch {
    // A missing store is the first-launch state; an unreadable one keeps the
    // file on disk and simply re-enters the Connection Screen.
    runtime.url = undefined
    runtime.certificatePins = new Map()
    return
  }

  if (contents.length > MAXIMUM_FILE_LENGTH) return void resetRuntime()

  try {
    const stored: unknown = JSON.parse(contents)
    if (typeof stored !== 'object' || stored === null) return void resetRuntime()

    const url = (stored as { url?: unknown }).url
    // The persisted URL is re-validated under the current runtime policy so a
    // hand-edited or policy-drifted entry cannot configure the device.
    runtime.url = typeof url === 'string' ? parseServerUrl(url) : undefined
    runtime.certificatePins = sanitizeCertificatePins(
      (stored as { certificatePins?: unknown }).certificatePins
    )
  } catch {
    resetRuntime()
  }
}

function resetRuntime(): void {
  runtime.url = undefined
  runtime.certificatePins = new Map()
}

function connectionPath(): string {
  return join(app.getPath('userData'), CONNECTION_FILE_NAME)
}
