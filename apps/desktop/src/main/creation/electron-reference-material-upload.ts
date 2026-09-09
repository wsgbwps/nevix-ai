import { app, net, session } from 'electron'
import { open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { currentServerConnectionUrl } from '../connection'
import { readCurrentSessionToken } from '../authentication'
import type {
  CreationReferenceMaterial,
  CreationReferenceMaterialUploadResult
} from '../../shared/ipc/creation/types'
import type {
  ReferenceMaterialUpload,
  ReferenceMaterialUploadDependencies,
  SignedUploadRequest
} from './reference-material-upload'

type Failure = Exclude<CreationReferenceMaterialUploadResult, { outcome: 'succeeded' }>
type Result<T> = { readonly outcome: 'succeeded'; readonly value: T } | Failure

export const electronReferenceMaterialUploadDependencies: ReferenceMaterialUploadDependencies = {
  serverUrl: currentServerConnectionUrl,
  sessionToken: readCurrentSessionToken,
  createId: randomUUID,
  developmentMode: () => !app.isPackaged,
  inspectFile: async (path) => {
    const handle = await open(path, 'r')
    try {
      const info = await handle.stat()
      return { regular: info.isFile(), byteSize: info.size }
    } finally {
      await handle.close()
    }
  },
  createUpload: async (serverUrl, token, sessionId, input, signal) => {
    const response = await requestJson(
      'POST',
      new URL(`/creation/sessions/${sessionId}/reference-material-uploads`, serverUrl),
      token,
      {
        idempotency_key: input.idempotencyKey,
        file_name: input.fileName,
        declared_kind: input.declaredKind,
        declared_mime_type: input.declaredMimeType,
        declared_byte_size: input.declaredByteSize
      },
      signal
    )
    if (response.outcome !== 'succeeded') return response
    const upload = parseUpload(response.value)
    const rawUploadRequest = isRecord(response.value) ? response.value.upload_request : undefined
    const uploadRequest =
      rawUploadRequest === undefined ? undefined : parseUploadRequest(rawUploadRequest)
    if (!upload || (rawUploadRequest !== undefined && uploadRequest === null)) {
      return { outcome: 'network-failure' }
    }
    return {
      outcome: 'succeeded',
      value: { upload, ...(uploadRequest ? { uploadRequest } : {}) }
    }
  },
  readCapability: async (serverUrl, token, signal) => {
    const response = await requestJson(
      'GET',
      new URL('/creation/object-storage-capability', serverUrl),
      token,
      undefined,
      signal
    )
    if (response.outcome !== 'succeeded') return response
    if (!isRecord(response.value) || typeof response.value.available !== 'boolean') {
      return { outcome: 'network-failure' }
    }
    if (!response.value.available) return { outcome: 'succeeded', value: { available: false } }
    const provider = stringField(response.value, 'provider')
    const uploadOrigin = stringField(response.value, 'upload_origin')
    const connectionRevision = positiveIntegerField(response.value, 'connection_revision')
    return (provider === 'oss' || provider === 'cos') && uploadOrigin && connectionRevision
      ? {
          outcome: 'succeeded',
          value: { available: true, provider, uploadOrigin, connectionRevision }
        }
      : { outcome: 'network-failure' }
  },
  putFile,
  readUpload: async (serverUrl, token, uploadId, signal) => {
    const response = await requestJson(
      'GET',
      new URL(`/creation/reference-material-uploads/${uploadId}`, serverUrl),
      token,
      undefined,
      signal
    )
    if (response.outcome !== 'succeeded') return response
    const upload = parseUpload(response.value)
    if (!upload) return { outcome: 'network-failure' }
    const material = isRecord(response.value) ? parseMaterial(response.value.material) : null
    return {
      outcome: 'succeeded',
      value: { upload, ...(material ? { material } : {}) }
    }
  },
  finalizeUpload: async (serverUrl, token, uploadId, signal) => {
    const response = await requestJson(
      'POST',
      new URL(`/creation/reference-material-uploads/${uploadId}`, serverUrl),
      token,
      undefined,
      signal,
      30 * 60_000
    )
    if (response.outcome !== 'succeeded') return response
    const upload = parseUpload(response.value)
    const material = isRecord(response.value) ? parseMaterial(response.value.material) : null
    return upload && material
      ? { outcome: 'succeeded', value: { upload, material } }
      : { outcome: 'network-failure' }
  }
}

async function requestJson(
  method: 'GET' | 'POST',
  url: URL,
  token: string,
  body?: unknown,
  signal?: AbortSignal,
  timeoutMs = 30_000
): Promise<Result<unknown>> {
  return new Promise((resolve) => {
    let settled = false
    let request: Electron.ClientRequest | undefined
    const timeout: { value?: ReturnType<typeof setTimeout> } = {}
    const cancel = (): void => {
      request?.abort()
      finish({ outcome: 'request-rejected', code: 'upload_cancelled' })
    }
    const finish = (result: Result<unknown>): void => {
      if (settled) return
      settled = true
      if (timeout.value !== undefined) clearTimeout(timeout.value)
      signal?.removeEventListener('abort', cancel)
      resolve(result)
    }
    if (signal?.aborted) return cancel()
    try {
      request = net.request({
        method,
        url: url.toString(),
        session: session.defaultSession,
        redirect: 'error',
        credentials: 'omit',
        useSessionCookies: false
      })
      request.setHeader('Authorization', `Bearer ${token}`)
      if (body !== undefined) request.setHeader('Content-Type', 'application/json')
    } catch {
      finish({ outcome: 'network-failure' })
      return
    }
    signal?.addEventListener('abort', cancel, { once: true })
    timeout.value = setTimeout(() => {
      request?.abort()
      finish({ outcome: 'network-failure' })
    }, timeoutMs)

    request.on('redirect', () => {
      request?.abort()
      finish({ outcome: 'network-failure' })
    })
    request.on('error', () => finish({ outcome: 'network-failure' }))
    request.on('response', (response) => {
      const chunks: Buffer[] = []
      let byteSize = 0
      response.on('data', (chunk: Buffer) => {
        byteSize += chunk.length
        if (byteSize > 1024 * 1024) {
          request?.abort()
          finish({ outcome: 'network-failure' })
          return
        }
        chunks.push(chunk)
      })
      response.on('error', () => finish({ outcome: 'network-failure' }))
      response.on('end', () => {
        const status = response.statusCode
        const payload = parseJson(Buffer.concat(chunks).toString('utf8'))
        if (status >= 200 && status < 300 && payload !== null) {
          finish({ outcome: 'succeeded', value: payload })
          return
        }
        if (status === 401) return finish({ outcome: 'unauthorized' })
        if (status === 403) return finish({ outcome: 'forbidden' })
        finish({ outcome: 'request-rejected', code: errorCode(payload) ?? 'internal_error' })
      })
    })
    try {
      if (body === undefined) request.end()
      else request.end(JSON.stringify(body))
    } catch {
      finish({ outcome: 'network-failure' })
    }
  })
}

export async function putFile(
  path: string,
  signed: SignedUploadRequest,
  expectedByteSize: number,
  onProgress?: (sentBytes: number, totalBytes: number) => void,
  signal?: AbortSignal
): Promise<{ readonly outcome: 'completed' | 'not-sent' | 'uncertain' | 'cancelled' }> {
  const handle = await open(path, 'r').catch(() => null)
  if (handle === null) return { outcome: 'not-sent' }
  const info = await handle.stat().catch(() => null)
  if (info === null || !info.isFile() || info.size !== expectedByteSize) {
    await handle.close().catch(() => undefined)
    return { outcome: 'not-sent' }
  }

  return new Promise((resolve) => {
    let sent = false
    let settled = false
    const progressTimer: { value?: ReturnType<typeof setInterval> } = {}
    const source = handle.createReadStream({
      autoClose: false,
      start: 0,
      end: expectedByteSize - 1
    })
    const finish = (outcome: 'completed' | 'not-sent' | 'uncertain' | 'cancelled'): void => {
      if (settled) return
      settled = true
      if (progressTimer.value !== undefined) clearInterval(progressTimer.value)
      signal?.removeEventListener('abort', cancel)
      source.destroy()
      void handle.close().catch(() => undefined)
      resolve({ outcome })
    }
    let request: Electron.ClientRequest
    const cancel = (): void => {
      request?.abort()
      finish('cancelled')
    }
    try {
      request = net.request({
        method: 'PUT',
        url: signed.url,
        session: session.defaultSession,
        redirect: 'error',
        credentials: 'omit',
        useSessionCookies: false
      })
      for (const [name, value] of Object.entries(signed.headers)) request.setHeader(name, value)
      request.chunkedEncoding = true
    } catch {
      finish('not-sent')
      return
    }
    if (signal?.aborted) return cancel()
    signal?.addEventListener('abort', cancel, { once: true })
    request.on('redirect', () => {
      request.abort()
      finish(sent ? 'uncertain' : 'not-sent')
    })
    request.on('error', () => finish(sent ? 'uncertain' : 'not-sent'))
    request.on('response', (response) => {
      response.on('error', () => finish('uncertain'))
      response.on('data', () => undefined)
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          onProgress?.(info.size, info.size)
          finish('completed')
          return
        }
        finish('uncertain')
      })
    })
    source.on('error', () => {
      request.abort()
      finish(sent ? 'uncertain' : 'not-sent')
    })
    source.on('data', (chunk: string | Buffer) => {
      source.pause()
      try {
        request.write(chunk, undefined, () => source.resume())
        sent = true
      } catch {
        finish(sent ? 'uncertain' : 'not-sent')
      }
    })
    source.on('end', () => {
      void handle.stat().then(
        (latest) => {
          if (!latest.isFile() || latest.size !== expectedByteSize) {
            request.abort()
            finish(sent ? 'uncertain' : 'not-sent')
            return
          }
          try {
            request.end()
          } catch {
            finish(sent ? 'uncertain' : 'not-sent')
          }
        },
        () => {
          request.abort()
          finish(sent ? 'uncertain' : 'not-sent')
        }
      )
    })
    progressTimer.value = setInterval(() => {
      try {
        const progress = request.getUploadProgress()
        if (!progress.active) return
        onProgress?.(progress.current, progress.total > 0 ? progress.total : info.size)
      } catch {
        // Progress is advisory; request/response events own transfer completion.
      }
    }, 100)
  })
}

function parseUpload(payload: unknown): ReferenceMaterialUpload | null {
  if (!isRecord(payload) || !isRecord(payload.upload)) return null
  const raw = payload.upload
  const id = stringField(raw, 'id')
  const status = stringField(raw, 'status')
  const connectionRevision = positiveIntegerField(raw, 'connection_revision')
  const putExpiresAt = stringField(raw, 'put_expires_at')
  const finalizeExpiresAt = stringField(raw, 'finalize_expires_at')
  if (
    !id ||
    (status !== 'pending' &&
      status !== 'verifying' &&
      status !== 'finalized' &&
      status !== 'terminal') ||
    !connectionRevision ||
    !putExpiresAt ||
    !finalizeExpiresAt
  ) {
    return null
  }
  return { id, status, connectionRevision, putExpiresAt, finalizeExpiresAt }
}

function parseUploadRequest(raw: unknown): SignedUploadRequest | null {
  if (!isRecord(raw)) return null
  const method = stringField(raw, 'method')
  const url = stringField(raw, 'url')
  const expiresAt = stringField(raw, 'expires_at')
  if (method !== 'PUT' || !url || !expiresAt || !isRecord(raw.headers)) return null
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw.headers)) {
    if (typeof value !== 'string') return null
    headers[name] = value
  }
  return { method, url, headers, expiresAt }
}

function parseMaterial(payload: unknown): CreationReferenceMaterial | null {
  if (!isRecord(payload)) return null
  const id = stringField(payload, 'id')
  const kind = stringField(payload, 'kind')
  const fileName = stringField(payload, 'file_name')
  const mimeType = stringField(payload, 'mime_type')
  const byteSize = nonNegativeIntegerField(payload, 'byte_size')
  const checksumSha256 = stringField(payload, 'checksum_sha256')
  const claimsVersion = positiveIntegerField(payload, 'claims_version')
  const createdAt = stringField(payload, 'created_at')
  if (
    !id ||
    (kind !== 'image' && kind !== 'video' && kind !== 'audio') ||
    fileName === null ||
    !mimeType ||
    byteSize === null ||
    !checksumSha256 ||
    !claimsVersion ||
    !createdAt
  ) {
    return null
  }
  const widthPx = nullableNumberField(payload, 'width_px')
  const heightPx = nullableNumberField(payload, 'height_px')
  const pixelCount = nullableNumberField(payload, 'pixel_count')
  const durationMs = nullableNumberField(payload, 'duration_ms')
  if ([widthPx, heightPx, pixelCount, durationMs].includes(undefined)) return null
  return {
    id,
    kind,
    fileName,
    mimeType,
    byteSize,
    widthPx: widthPx ?? null,
    heightPx: heightPx ?? null,
    pixelCount: pixelCount ?? null,
    durationMs: durationMs ?? null,
    checksumSha256,
    claimsVersion,
    createdAt
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  return typeof source[key] === 'string' ? source[key] : null
}

function positiveIntegerField(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function nonNegativeIntegerField(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function nullableNumberField(
  source: Record<string, unknown>,
  key: string
): number | null | undefined {
  const value = source[key]
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function errorCode(payload: unknown): string | null {
  return isRecord(payload) ? stringField(payload, 'error') : null
}
