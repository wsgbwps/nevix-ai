/**
 * The AI Provider Connection settings client (contracts/creation.yaml,
 * issue #157). Every call rides the current session's opaque Bearer token;
 * the Provider Key only travels upward inside a configure/replace command
 * and is never persisted, echoed, or logged by this client.
 */

import { request, type CreationApiFailure, type CreationApiResult } from './go-creation-http'

export type ProviderAdminState = 'enabled' | 'paused'
export type ProviderCredentialState = 'checking' | 'valid' | 'invalid' | 'credential_unavailable'
export type ProviderMediaCapability = 'checking' | 'available' | 'unavailable'
export type ProviderCheckOutcome = 'completed' | 'temporarily_unavailable'

/** The sanitized admin governance view; key material never appears here. */
export interface ProviderConnectionView {
  readonly id: string
  readonly adminState: ProviderAdminState
  readonly credentialState: ProviderCredentialState
  readonly imageCapability: ProviderMediaCapability
  readonly videoCapability: ProviderMediaCapability
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastCheckedAt: string | null
  readonly lastCheckOutcome: ProviderCheckOutcome | null
  readonly needsAttention: boolean
}

/** One media's member-facing projection: status, stable reason, advice. */
export interface MediaCapabilityStatus {
  readonly status: ProviderMediaCapability
  readonly reason: string | null
  readonly action: 'wait' | 'contact_admin' | null
}

export interface MediaCapabilitiesView {
  readonly image: MediaCapabilityStatus
  readonly video: MediaCapabilityStatus
}

/** The view plus the one absence outcome the admin surface must render. */
export type ProviderConnectionLookup =
  | { readonly outcome: 'configured'; readonly connection: ProviderConnectionView }
  | { readonly outcome: 'not-configured' }
  | { readonly outcome: 'load-failed' }
  | { readonly outcome: 'unauthorized' }

/** The segment's shared trusted-command failure shape. */
type RequestFailure = CreationApiFailure

async function commandRequest(
  serverUrl: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  token: string,
  body?: unknown
): Promise<{ readonly outcome: 'succeeded'; readonly payload: unknown } | RequestFailure> {
  return request(serverUrl, { method, path, token, body })
}

function readString(source: unknown, field: string): string | null {
  if (typeof source === 'object' && source !== null && field in source) {
    const value = (source as Record<string, unknown>)[field]
    if (typeof value === 'string') return value
  }
  return null
}

function parseConnectionView(payload: unknown): ProviderConnectionView | null {
  const id = readString(payload, 'id')
  const adminState = readString(payload, 'admin_state')
  const credentialState = readString(payload, 'credential_state')
  const imageCapability = readString(payload, 'image_capability')
  const videoCapability = readString(payload, 'video_capability')
  const createdAt = readString(payload, 'created_at')
  const updatedAt = readString(payload, 'updated_at')
  if (
    !id ||
    (adminState !== 'enabled' && adminState !== 'paused') ||
    !isCredentialState(credentialState) ||
    !isMediaCapability(imageCapability) ||
    !isMediaCapability(videoCapability) ||
    !createdAt ||
    !updatedAt
  ) {
    return null
  }
  const lastCheckedAt = readString(payload, 'last_checked_at')
  const lastCheckOutcome = readString(payload, 'last_check_outcome')
  const needsAttentionRaw = (payload as Record<string, unknown>).needs_attention
  if (typeof needsAttentionRaw !== 'boolean') return null
  return {
    id,
    adminState,
    credentialState,
    imageCapability,
    videoCapability,
    createdAt,
    updatedAt,
    lastCheckedAt,
    lastCheckOutcome:
      lastCheckOutcome === 'completed' || lastCheckOutcome === 'temporarily_unavailable'
        ? lastCheckOutcome
        : null,
    needsAttention: needsAttentionRaw
  }
}

function isCredentialState(value: string | null): value is ProviderCredentialState {
  return (
    value === 'checking' ||
    value === 'valid' ||
    value === 'invalid' ||
    value === 'credential_unavailable'
  )
}

function isMediaCapability(value: string | null): value is ProviderMediaCapability {
  return value === 'checking' || value === 'available' || value === 'unavailable'
}

function parseMediaCapabilities(payload: unknown): MediaCapabilitiesView | null {
  if (typeof payload !== 'object' || payload === null) return null
  const image = parseCapabilityStatus((payload as Record<string, unknown>).image)
  const video = parseCapabilityStatus((payload as Record<string, unknown>).video)
  return image && video ? { image, video } : null
}

function parseCapabilityStatus(entry: unknown): MediaCapabilityStatus | null {
  const status = readString(entry, 'status')
  if (!isMediaCapability(status)) return null
  const reason = readString(entry, 'reason')
  const action = readString(entry, 'action')
  return {
    status,
    reason,
    action: action === 'wait' || action === 'contact_admin' ? action : null
  }
}

/**
 * Creates the typed connection client over one configured server URL.
 * Paths mirror contracts/creation.yaml; parsing fails closed rather than
 * guessing shapes.
 */
export function createProviderConnectionClient(serverUrl: string): {
  lookup(token: string): Promise<ProviderConnectionLookup>
  configure(
    token: string,
    proof: string,
    providerKey: string
  ): Promise<CreationApiResult<ProviderConnectionView>>
  replaceCredential(
    token: string,
    proof: string,
    providerKey: string
  ): Promise<CreationApiResult<ProviderConnectionView>>
  setAdminState(
    token: string,
    adminState: ProviderAdminState
  ): Promise<CreationApiResult<ProviderConnectionView>>
  recheck(token: string): Promise<CreationApiResult<ProviderConnectionView>>
  deleteConnection(token: string, proof: string): Promise<CreationApiResult<ProviderConnectionView>>
  listMediaCapabilities(token: string): Promise<CreationApiResult<MediaCapabilitiesView>>
} {
  return {
    lookup: async (token) => {
      const result = await commandRequest(serverUrl, 'GET', '/creation/provider-connection', token)
      if (result.outcome === 'unauthorized') return { outcome: 'unauthorized' }
      if (
        result.outcome === 'request-rejected' &&
        result.code === 'provider_connection_not_configured'
      ) {
        return { outcome: 'not-configured' }
      }
      if (result.outcome !== 'succeeded') return { outcome: 'load-failed' }
      const view = parseConnectionView(result.payload)
      return view ? { outcome: 'configured', connection: view } : { outcome: 'load-failed' }
    },
    configure: async (token, proof, providerKey) => {
      const result = await commandRequest(
        serverUrl,
        'POST',
        '/creation/provider-connection',
        token,
        {
          proof,
          provider_key: providerKey
        }
      )
      return parseCommandResult(result, parseConnectionView)
    },
    replaceCredential: async (token, proof, providerKey) => {
      const result = await commandRequest(
        serverUrl,
        'PUT',
        '/creation/provider-connection/credential',
        token,
        {
          proof,
          provider_key: providerKey
        }
      )
      return parseCommandResult(result, parseConnectionView)
    },
    setAdminState: async (token, adminState) => {
      const result = await commandRequest(
        serverUrl,
        'PATCH',
        '/creation/provider-connection',
        token,
        {
          admin_state: adminState
        }
      )
      return parseCommandResult(result, parseConnectionView)
    },
    recheck: async (token) => {
      const result = await commandRequest(
        serverUrl,
        'POST',
        '/creation/provider-connection/recheck',
        token
      )
      return parseCommandResult(result, parseConnectionView)
    },
    deleteConnection: async (token, proof) => {
      const result = await commandRequest(
        serverUrl,
        'DELETE',
        '/creation/provider-connection',
        token,
        {
          proof
        }
      )
      return parseCommandResult(result, parseConnectionView)
    },
    listMediaCapabilities: async (token) => {
      const result = await commandRequest(serverUrl, 'GET', '/creation/media-capabilities', token)
      if (result.outcome === 'succeeded') {
        const view = parseMediaCapabilities(result.payload)
        return view ? { outcome: 'succeeded', value: view } : { outcome: 'network-failure' }
      }
      if (result.outcome === 'unauthorized') return { outcome: 'unauthorized' }
      if (result.outcome === 'forbidden') return { outcome: 'forbidden' }
      if (result.outcome === 'request-rejected') {
        return { outcome: 'request-rejected', code: result.code }
      }
      return { outcome: 'network-failure' }
    }
  }
}

function parseCommandResult<T>(
  result: { readonly outcome: 'succeeded'; readonly payload: unknown } | RequestFailure,
  parse: (payload: unknown) => T | null
): CreationApiResult<T> {
  if (result.outcome === 'succeeded') {
    const value = parse(result.payload)
    return value ? { outcome: 'succeeded', value } : { outcome: 'network-failure' }
  }
  return result
}
