import type {
  CreationMaterialKind,
  CreationReferenceMaterial,
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
  readonly createId: () => string
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
}

export async function runReferenceMaterialUpload(
  input: Omit<CreationReferenceMaterialUploadRequest, 'operationId'>,
  dependencies: ReferenceMaterialUploadDependencies,
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
      idempotencyKey: dependencies.createId(),
      fileName: input.fileName,
      declaredKind: input.declaredKind,
      declaredMimeType: input.declaredMimeType,
      declaredByteSize: input.declaredByteSize
    },
    signal
  )
  if (created.outcome !== 'succeeded') return created
  if (created.value.uploadRequest === undefined) {
    return { outcome: 'request-rejected', code: 'upload_requires_reselection' }
  }

  const capability = await dependencies.readCapability(serverUrl, token, signal)
  if (capability.outcome !== 'succeeded') return capability
  if (
    !capability.value.available ||
    capability.value.connectionRevision !== created.value.upload.connectionRevision ||
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
    return { outcome: 'request-rejected', code: 'upload_cancelled' }
  }
  if (transfer.outcome === 'uncertain') {
    const status = await dependencies.readUpload(serverUrl, token, created.value.upload.id, signal)
    if (status.outcome !== 'succeeded') return status
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
  return finalized.outcome === 'succeeded'
    ? { outcome: 'succeeded', value: finalized.value.material }
    : finalized
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
