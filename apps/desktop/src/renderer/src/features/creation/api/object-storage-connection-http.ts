import { request, type CreationApiResult } from './go-creation-http'

export type ObjectStorageProvider = 'oss' | 'cos'
export type ObjectStorageConnectionState = 'unconfigured' | 'ready' | 'credential_unavailable'

export interface ObjectStorageCredentialView {
  readonly accessKeyIdMasked: string
  readonly secretAccessKeyConfigured: boolean
}

export interface ObjectStorageObservationView {
  readonly checkedAt: string
  readonly outcome: 'completed'
}

export type ObjectStorageConnectionView =
  | { readonly state: 'unconfigured' }
  | {
      readonly state: 'ready' | 'credential_unavailable'
      readonly provider: ObjectStorageProvider
      readonly region: string
      readonly bucket: string
      readonly revision: number
      readonly credential: ObjectStorageCredentialView
      readonly observation?: ObjectStorageObservationView
    }

export interface ObjectStorageConnectionInput {
  readonly proof: string
  readonly provider: ObjectStorageProvider
  readonly region: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

export type ObjectStorageCapabilityView =
  | {
      readonly available: false
      readonly provider?: ObjectStorageProvider
      readonly connectionRevision?: number
    }
  | {
      readonly available: true
      readonly provider: ObjectStorageProvider
      readonly uploadOrigin: string
      readonly connectionRevision: number
    }

export function createObjectStorageConnectionClient(serverUrl: string): {
  getAdminConnection(token: string): Promise<CreationApiResult<ObjectStorageConnectionView>>
  create(
    token: string,
    input: ObjectStorageConnectionInput
  ): Promise<CreationApiResult<Exclude<ObjectStorageConnectionView, { state: 'unconfigured' }>>>
  getCapability(token: string): Promise<CreationApiResult<ObjectStorageCapabilityView>>
} {
  return {
    getAdminConnection: async (token) => {
      const result = await request(serverUrl, {
        method: 'GET',
        path: '/creation/object-storage-connection',
        token
      })
      if (result.outcome !== 'succeeded') return result
      const view = parseConnection(result.payload)
      return view ? { outcome: 'succeeded', value: view } : { outcome: 'network-failure' }
    },
    create: async (token, input) => {
      const result = await request(serverUrl, {
        method: 'POST',
        path: '/creation/object-storage-connection',
        token,
        body: {
          proof: input.proof,
          provider: input.provider,
          region: input.region,
          bucket: input.bucket,
          access_key_id: input.accessKeyId,
          secret_access_key: input.secretAccessKey
        }
      })
      if (result.outcome !== 'succeeded') return result
      const view = parseConnection(result.payload)
      return view?.state === 'ready' || view?.state === 'credential_unavailable'
        ? { outcome: 'succeeded', value: view }
        : { outcome: 'network-failure' }
    },
    getCapability: async (token) => {
      const result = await request(serverUrl, {
        method: 'GET',
        path: '/creation/object-storage-capability',
        token
      })
      if (result.outcome !== 'succeeded') return result
      const view = parseCapability(result.payload)
      return view ? { outcome: 'succeeded', value: view } : { outcome: 'network-failure' }
    }
  }
}

function parseConnection(payload: unknown): ObjectStorageConnectionView | undefined {
  if (!isRecord(payload)) return undefined
  if (payload.state === 'unconfigured') return { state: 'unconfigured' }
  if (payload.state !== 'ready' && payload.state !== 'credential_unavailable') return undefined

  const provider = readProvider(payload.provider)
  const region = readNonEmptyString(payload.region)
  const bucket = readNonEmptyString(payload.bucket)
  const revision = readPositiveInteger(payload.revision)
  const credential = parseCredential(payload.credential)
  if (!provider || !region || !bucket || revision === undefined || !credential) return undefined

  const observation =
    payload.observation === undefined ? undefined : parseObservation(payload.observation)
  if (payload.observation !== undefined && !observation) return undefined

  return {
    state: payload.state,
    provider,
    region,
    bucket,
    revision,
    credential,
    ...(observation ? { observation } : {})
  }
}

function parseCredential(payload: unknown): ObjectStorageCredentialView | undefined {
  if (!isRecord(payload)) return undefined
  const accessKeyIdMasked = readNonEmptyString(payload.access_key_id_masked)
  if (!accessKeyIdMasked || typeof payload.secret_access_key_configured !== 'boolean') {
    return undefined
  }
  return {
    accessKeyIdMasked,
    secretAccessKeyConfigured: payload.secret_access_key_configured
  }
}

function parseObservation(payload: unknown): ObjectStorageObservationView | undefined {
  if (!isRecord(payload)) return undefined
  const checkedAt = readNonEmptyString(payload.checked_at)
  return checkedAt && payload.outcome === 'completed'
    ? { checkedAt, outcome: 'completed' }
    : undefined
}

function parseCapability(payload: unknown): ObjectStorageCapabilityView | undefined {
  if (!isRecord(payload) || typeof payload.available !== 'boolean') return undefined
  if (payload.available) {
    const provider = readProvider(payload.provider)
    const uploadOrigin = readNonEmptyString(payload.upload_origin)
    const connectionRevision = readPositiveInteger(payload.connection_revision)
    return provider && uploadOrigin && connectionRevision !== undefined
      ? { available: true, provider, uploadOrigin, connectionRevision }
      : undefined
  }

  if (payload.provider === undefined && payload.connection_revision === undefined) {
    return { available: false }
  }
  const provider = readProvider(payload.provider)
  const connectionRevision = readPositiveInteger(payload.connection_revision)
  return provider && connectionRevision !== undefined
    ? { available: false, provider, connectionRevision }
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function readProvider(value: unknown): ObjectStorageProvider | undefined {
  return value === 'oss' || value === 'cos' ? value : undefined
}
