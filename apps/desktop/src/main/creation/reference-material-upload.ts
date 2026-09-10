import type {
  CreationMaterialKind,
  CreationReferenceMaterial,
  CreationReferenceMaterialUploadAbortResult,
  CreationReferenceMaterialUploadRecovery,
  CreationReferenceMaterialUploadRequest,
  CreationReferenceMaterialUploadResult
} from '../../shared/ipc/creation/types'

export interface ReferenceMaterialUpload {
  readonly id: string
  readonly status: 'pending' | 'verifying' | 'finalized' | 'terminal'
  readonly connectionRevision: number
  readonly putExpiresAt: string
  readonly finalizeExpiresAt: string
}

export interface SignedUploadRequest {
  readonly method: 'PUT'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly expiresAt: string
}

type Failure = Exclude<CreationReferenceMaterialUploadResult, { outcome: 'succeeded' }>
type Result<T> = { readonly outcome: 'succeeded'; readonly value: T } | Failure

export interface ReferenceMaterialUploadDependencies {
  readonly serverUrl: () => string | undefined
  readonly sessionToken: () => Promise<string | undefined>
  readonly developmentMode: () => boolean
  readonly inspectFile: (
    localPath: string
  ) => Promise<{ readonly regular: boolean; readonly byteSize: number }>
  readonly createUpload: (
    serverUrl: string,
    token: string,
    sessionId: string,
    input: {
      readonly idempotencyKey: string
      readonly fileName: string
      readonly declaredKind: CreationMaterialKind
      readonly declaredMimeType: string
      readonly declaredByteSize: number
    },
    signal?: AbortSignal
  ) => Promise<
    Result<{
      readonly upload: ReferenceMaterialUpload
      readonly uploadRequest?: SignedUploadRequest
    }>
  >
  readonly readCapability: (
    serverUrl: string,
    token: string,
    signal?: AbortSignal
  ) => Promise<
    Result<{
      readonly available: boolean
      readonly provider?: 'oss' | 'cos'
      readonly uploadOrigin?: string
      readonly connectionRevision?: number
    }>
  >
  readonly putFile: (
    localPath: string,
    request: SignedUploadRequest,
    expectedByteSize: number,
    onProgress?: (sentBytes: number, totalBytes: number) => void,
    signal?: AbortSignal
  ) => Promise<{ readonly outcome: 'completed' | 'not-sent' | 'uncertain' | 'cancelled' }>
  readonly readUpload: (
    serverUrl: string,
    token: string,
    uploadId: string,
    signal?: AbortSignal
  ) => Promise<
    Result<{
      readonly upload: ReferenceMaterialUpload
      readonly material?: CreationReferenceMaterial
    }>
  >
  readonly finalizeUpload: (
    serverUrl: string,
    token: string,
    uploadId: string,
    signal?: AbortSignal
  ) => Promise<
    Result<{
      readonly upload: ReferenceMaterialUpload
      readonly material: CreationReferenceMaterial
    }>
  >
  readonly abortUpload: (
    serverUrl: string,
    token: string,
    uploadId: string,
    signal?: AbortSignal
  ) => Promise<
    Result<{
      readonly upload: ReferenceMaterialUpload
      readonly material?: CreationReferenceMaterial
    }>
  >
}

export async function runReferenceMaterialUpload(
  input: Omit<CreationReferenceMaterialUploadRequest, 'operationId'>,
  dependencies: ReferenceMaterialUploadDependencies,
  onLease?: (recovery: Required<CreationReferenceMaterialUploadRecovery>) => void,
  onProgress?: (sentBytes: number, totalBytes: number) => void,
  signal?: AbortSignal
): Promise<CreationReferenceMaterialUploadResult> {
  const file = await dependencies.inspectFile(input.localPath).catch(() => null)
  if (file === null || !file.regular || file.byteSize !== input.declaredByteSize) {
    return { outcome: 'request-rejected', code: 'invalid_local_file' }
  }
  const serverUrl = dependencies.serverUrl()
  if (serverUrl !== undefined && !validServerBaseUrl(serverUrl, dependencies.developmentMode())) {
    return { outcome: 'network-failure' }
  }
  const token = await dependencies.sessionToken()
  if (serverUrl === undefined || token === undefined) return { outcome: 'unauthorized' }

  const created = await dependencies.createUpload(
    serverUrl,
    token,
    input.sessionId,
    {
      idempotencyKey: input.idempotencyKey,
      fileName: input.fileName,
      declaredKind: input.declaredKind,
      declaredMimeType: input.declaredMimeType,
      declaredByteSize: input.declaredByteSize
    },
    signal
  )
  if (created.outcome !== 'succeeded') return normalizeUploadReplayFailure(created)
  onLease?.({
    uploadId: created.value.upload.id,
    idempotencyKey: input.idempotencyKey,
    sessionId: input.sessionId,
    fileName: input.fileName,
    declaredKind: input.declaredKind,
    declaredMimeType: input.declaredMimeType,
    declaredByteSize: input.declaredByteSize,
    putExpiresAt: created.value.upload.putExpiresAt,
    finalizeExpiresAt: created.value.upload.finalizeExpiresAt
  })
  if (created.value.uploadRequest === undefined) {
    if (created.value.upload.status === 'terminal') {
      return { outcome: 'request-rejected', code: 'upload_terminal' }
    }
    const current = await dependencies.readUpload(serverUrl, token, created.value.upload.id, signal)
    if (current.outcome !== 'succeeded') return normalizeRecoveryFailure(current)
    if (current.value.upload.status === 'finalized') {
      return current.value.material
        ? { outcome: 'succeeded', value: current.value.material }
        : { outcome: 'network-failure' }
    }
    if (current.value.upload.status === 'terminal') {
      return { outcome: 'request-rejected', code: 'upload_terminal' }
    }
    if (current.value.upload.status === 'verifying') {
      return { outcome: 'request-rejected', code: 'reference_material_upload_verifying' }
    }
    const finalized = await dependencies.finalizeUpload(
      serverUrl,
      token,
      created.value.upload.id,
      signal
    )
    return finalized.outcome === 'succeeded'
      ? { outcome: 'succeeded', value: finalized.value.material }
      : normalizeRecoveryFailure(finalized)
  }

  const capability = await dependencies.readCapability(serverUrl, token, signal)
  if (capability.outcome !== 'succeeded') {
    return abortCancelledUpload(capability, dependencies, serverUrl, token, created.value.upload.id)
  }
  if (
    !capability.value.available ||
    capability.value.provider === undefined ||
    capability.value.uploadOrigin === undefined ||
    !validSignedRequest(
      created.value.uploadRequest,
      created.value.upload,
      capability.value.provider,
      capability.value.uploadOrigin,
      input.declaredMimeType
    )
  ) {
    return { outcome: 'network-failure' }
  }

  const transfer = await dependencies.putFile(
    input.localPath,
    created.value.uploadRequest,
    input.declaredByteSize,
    onProgress,
    signal
  )
  if (transfer.outcome === 'not-sent') {
    return { outcome: 'request-rejected', code: 'upload_requires_reselection' }
  }
  if (transfer.outcome === 'cancelled') {
    return abortCancelledUpload(
      { outcome: 'request-rejected', code: 'upload_cancelled' },
      dependencies,
      serverUrl,
      token,
      created.value.upload.id
    )
  }
  if (transfer.outcome === 'uncertain') {
    const status = await dependencies.readUpload(serverUrl, token, created.value.upload.id, signal)
    if (status.outcome !== 'succeeded') {
      return abortCancelledUpload(status, dependencies, serverUrl, token, created.value.upload.id)
    }
    if (status.value.upload.status === 'finalized') {
      return status.value.material
        ? { outcome: 'succeeded', value: status.value.material }
        : { outcome: 'network-failure' }
    }
    if (status.value.upload.status === 'terminal') {
      return { outcome: 'request-rejected', code: 'upload_terminal' }
    }
  }

  const finalized = await dependencies.finalizeUpload(
    serverUrl,
    token,
    created.value.upload.id,
    signal
  )
  switch (finalized.outcome) {
    case 'succeeded':
      return { outcome: 'succeeded', value: finalized.value.material }
    case 'request-rejected':
      return abortCancelledUpload(
        normalizeRecoveryFailure(finalized),
        dependencies,
        serverUrl,
        token,
        created.value.upload.id
      )
    default:
      return abortCancelledUpload(
        finalized,
        dependencies,
        serverUrl,
        token,
        created.value.upload.id
      )
  }
}

export async function recoverReferenceMaterialUpload(
  recovery: CreationReferenceMaterialUploadRecovery,
  dependencies: ReferenceMaterialUploadDependencies,
  signal?: AbortSignal
): Promise<CreationReferenceMaterialUploadResult> {
  const serverUrl = dependencies.serverUrl()
  if (serverUrl !== undefined && !validServerBaseUrl(serverUrl, dependencies.developmentMode())) {
    return { outcome: 'network-failure' }
  }
  const token = await dependencies.sessionToken()
  if (serverUrl === undefined || token === undefined) return { outcome: 'unauthorized' }

  let uploadId = recovery.uploadId
  if (uploadId === undefined) {
    const created = await dependencies.createUpload(
      serverUrl,
      token,
      recovery.sessionId,
      {
        idempotencyKey: recovery.idempotencyKey,
        fileName: recovery.fileName,
        declaredKind: recovery.declaredKind,
        declaredMimeType: recovery.declaredMimeType,
        declaredByteSize: recovery.declaredByteSize
      },
      signal
    )
    if (created.outcome !== 'succeeded') return normalizeRecoveryFailure(created)
    uploadId = created.value.upload.id
  }

  const current = await dependencies.readUpload(serverUrl, token, uploadId, signal)
  if (current.outcome !== 'succeeded') return normalizeRecoveryFailure(current)
  if (current.value.upload.status === 'finalized') {
    return current.value.material
      ? { outcome: 'succeeded', value: current.value.material }
      : { outcome: 'network-failure' }
  }
  if (current.value.upload.status === 'terminal') {
    return { outcome: 'request-rejected', code: 'upload_terminal' }
  }
  const finalized = await dependencies.finalizeUpload(serverUrl, token, uploadId, signal)
  return finalized.outcome === 'succeeded'
    ? { outcome: 'succeeded', value: finalized.value.material }
    : normalizeRecoveryFailure(finalized)
}

export async function abortReferenceMaterialUploadRecovery(
  recovery: CreationReferenceMaterialUploadRecovery,
  dependencies: ReferenceMaterialUploadDependencies,
  signal?: AbortSignal
): Promise<CreationReferenceMaterialUploadAbortResult> {
  const serverUrl = dependencies.serverUrl()
  if (serverUrl !== undefined && !validServerBaseUrl(serverUrl, dependencies.developmentMode())) {
    return { outcome: 'network-failure' }
  }
  const token = await dependencies.sessionToken()
  if (serverUrl === undefined || token === undefined) return { outcome: 'unauthorized' }

  let uploadId = recovery.uploadId
  if (uploadId === undefined) {
    const created = await dependencies.createUpload(
      serverUrl,
      token,
      recovery.sessionId,
      {
        idempotencyKey: recovery.idempotencyKey,
        fileName: recovery.fileName,
        declaredKind: recovery.declaredKind,
        declaredMimeType: recovery.declaredMimeType,
        declaredByteSize: recovery.declaredByteSize
      },
      signal
    )
    if (created.outcome !== 'succeeded') {
      if (
        created.outcome === 'request-rejected' &&
        (created.code === 'reference_material_upload_terminal' ||
          created.code === 'reference_material_upload_expired')
      ) {
        return { outcome: 'succeeded', value: null }
      }
      return created
    }
    uploadId = created.value.upload.id
  }

  const aborted = await dependencies.abortUpload(serverUrl, token, uploadId, signal)
  return aborted.outcome === 'succeeded'
    ? { outcome: 'succeeded', value: aborted.value.material ?? null }
    : aborted
}

function normalizeRecoveryFailure(result: Failure): Failure {
  if (result.outcome !== 'request-rejected') return result
  switch (result.code) {
    case 'reference_material_upload_put_required':
      return { outcome: 'request-rejected', code: 'upload_requires_reselection' }
    case 'reference_material_upload_terminal':
    case 'reference_material_upload_expired':
    case 'not_found':
    case 'material_upload_size_mismatch':
    case 'material_upload_metadata_mismatch':
    case 'material_too_large':
    case 'material_unsupported_media':
    case 'material_unreadable_media':
      return { outcome: 'request-rejected', code: 'upload_terminal' }
    default:
      return result
  }
}

function normalizeUploadReplayFailure(result: Failure): Failure {
  if (
    result.outcome === 'request-rejected' &&
    (result.code === 'reference_material_upload_terminal' ||
      result.code === 'reference_material_upload_expired')
  ) {
    return { outcome: 'request-rejected', code: 'upload_terminal' }
  }
  return result
}

async function abortCancelledUpload(
  result: Failure,
  dependencies: ReferenceMaterialUploadDependencies,
  serverUrl: string,
  token: string,
  uploadId: string
): Promise<Failure> {
  if (result.outcome === 'request-rejected' && result.code === 'upload_cancelled') {
    await dependencies.abortUpload(serverUrl, token, uploadId).catch(() => undefined)
  }
  return result
}

function validSignedRequest(
  request: SignedUploadRequest,
  upload: ReferenceMaterialUpload,
  provider: 'oss' | 'cos',
  uploadOrigin: string,
  declaredMimeType: string
): boolean {
  let target: URL
  let allowedOrigin: URL
  try {
    target = new URL(request.url)
    allowedOrigin = new URL(uploadOrigin)
  } catch {
    return false
  }
  if (
    request.method !== 'PUT' ||
    target.protocol !== 'https:' ||
    allowedOrigin.protocol !== 'https:' ||
    allowedOrigin.username !== '' ||
    allowedOrigin.password !== '' ||
    allowedOrigin.pathname !== '/' ||
    allowedOrigin.search !== '' ||
    allowedOrigin.hash !== '' ||
    uploadOrigin !== allowedOrigin.origin ||
    target.origin !== allowedOrigin.origin ||
    target.username !== '' ||
    target.password !== '' ||
    target.hash !== '' ||
    request.expiresAt !== upload.putExpiresAt
  ) {
    return false
  }

  const headers = new Map<string, string>()
  for (const [name, value] of Object.entries(request.headers)) {
    const normalized = name.toLowerCase()
    if (headers.has(normalized)) return false
    headers.set(normalized, value)
  }
  const metadata = `x-${provider}-meta-upload-id`
  const forbidOverwrite = `x-${provider}-forbid-overwrite`
  const expected = new Set(['content-type', metadata, forbidOverwrite])
  if (headers.size !== expected.size || [...headers.keys()].some((name) => !expected.has(name))) {
    return false
  }
  return (
    headers.get('content-type') === declaredMimeType &&
    headers.get(metadata) === upload.id &&
    headers.get(forbidOverwrite) === 'true'
  )
}

function validServerBaseUrl(value: string, developmentMode: boolean): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'https:' ||
        (developmentMode &&
          url.protocol === 'http:' &&
          (url.hostname === 'localhost' ||
            url.hostname === '127.0.0.1' ||
            url.hostname === '[::1]'))) &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}
