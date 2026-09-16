import type { CreationApiFailure, CreationApiResult } from './go-creation-http'
import { readErrorCode, request } from './go-creation-http'

export type AssetMediaType = 'image' | 'video'
export type AssetSort = 'newest' | 'oldest'

export interface AssetCreatorView {
  readonly id: string
  readonly displayName: string
}

export interface AssetCapabilities {
  readonly canDelete: boolean
  readonly canCreateSimilar: boolean
}

export interface MediaAssetView {
  readonly id: string
  readonly creator: AssetCreatorView
  readonly mediaType: AssetMediaType
  readonly mimeType: string
  readonly byteSize: number
  readonly checksumSha256: string
  readonly widthPx: number | null
  readonly heightPx: number | null
  readonly durationMs: number | null
  readonly createdAt: string
  readonly capabilities: AssetCapabilities
}

export interface AssetPageRequest {
  readonly cursor?: string | null
  readonly mediaType?: AssetMediaType
  readonly creator?: string
  readonly createdSince?: string
  readonly sort?: AssetSort
  readonly search?: string
  readonly limit?: number
}

export interface AssetPage {
  readonly assets: readonly MediaAssetView[]
  readonly nextCursor: string | null
}

export interface AssetGenerationSpecification {
  readonly mediaType: AssetMediaType
  readonly prompt: string
  readonly model: string
  readonly mode: string
  readonly manifestVersion: number
  readonly ratio: string | null
  readonly resolution: string | null
  readonly quantity: number
  readonly durationSeconds: number | null
}

export interface AssetPrivateOrigin {
  readonly sessionId: string
  readonly sessionName: string | null
  readonly taskId: string
  readonly slotIndex: number
  readonly specification: AssetGenerationSpecification
}

export interface AssetDetailView {
  readonly asset: MediaAssetView
  readonly siblings: readonly MediaAssetView[]
  readonly privateOrigin: AssetPrivateOrigin | null
}

export interface AssetContentOptions {
  readonly signal?: AbortSignal
  readonly purpose?: 'preview' | 'download'
}

export interface AssetLibraryPorts {
  readonly listAssets: (request: AssetPageRequest) => Promise<CreationApiResult<AssetPage>>
  readonly getAsset: (assetId: string) => Promise<CreationApiResult<AssetDetailView>>
  readonly loadAssetContent: (
    assetId: string,
    checksumSha256: string,
    options?: AssetContentOptions
  ) => Promise<CreationApiResult<Blob>>
  readonly deleteAsset: (assetId: string) => Promise<CreationApiResult<void>>
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function stringField(value: unknown, field: string): string | null {
  const candidate = record(value)?.[field]
  return typeof candidate === 'string' ? candidate : null
}

function numberField(value: unknown, field: string): number | null {
  const candidate = record(value)?.[field]
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null
}

function nullableStringField(value: unknown, field: string): string | null | undefined {
  const source = record(value)
  if (source === null || !(field in source)) return undefined
  const candidate = source[field]
  if (candidate === null) return null
  return typeof candidate === 'string' ? candidate : undefined
}

function nullableNumberField(value: unknown, field: string): number | null | undefined {
  const source = record(value)
  if (source === null || !(field in source)) return undefined
  const candidate = source[field]
  if (candidate === null) return null
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined
}

function parseCapabilities(value: unknown): AssetCapabilities | null {
  const source = record(value)
  if (source === null) return null
  const canDelete = source['can_delete']
  const canCreateSimilar = source['can_create_similar']
  return typeof canDelete === 'boolean' && typeof canCreateSimilar === 'boolean'
    ? { canDelete, canCreateSimilar }
    : null
}

function parseAsset(value: unknown): MediaAssetView | null {
  const id = stringField(value, 'id')
  const creatorValue = record(value)?.['creator']
  const creatorId = stringField(creatorValue, 'id')
  const displayName = stringField(creatorValue, 'display_name')
  const mediaType = stringField(value, 'media_type')
  const mimeType = stringField(value, 'mime_type')
  const byteSize = numberField(value, 'byte_size')
  const checksumSha256 = stringField(value, 'checksum_sha256')
  const widthPx = nullableNumberField(value, 'width_px')
  const heightPx = nullableNumberField(value, 'height_px')
  const durationMs = nullableNumberField(value, 'duration_ms')
  const createdAt = stringField(value, 'created_at')
  const capabilities = parseCapabilities(record(value)?.['capabilities'])
  if (
    !id ||
    !creatorId ||
    displayName === null ||
    (mediaType !== 'image' && mediaType !== 'video') ||
    !mimeType ||
    byteSize === null ||
    !checksumSha256 ||
    widthPx === undefined ||
    heightPx === undefined ||
    durationMs === undefined ||
    !createdAt ||
    capabilities === null
  ) {
    return null
  }
  return {
    id,
    creator: { id: creatorId, displayName },
    mediaType,
    mimeType,
    byteSize,
    checksumSha256,
    widthPx,
    heightPx,
    durationMs,
    createdAt,
    capabilities
  }
}

function parsePage(value: unknown): AssetPage | null {
  const source = record(value)
  if (source === null || !Array.isArray(source['assets'])) return null
  const assets: MediaAssetView[] = []
  for (const item of source['assets']) {
    const parsed = parseAsset(item)
    if (parsed === null) return null
    assets.push(parsed)
  }
  const nextCursor = nullableStringField(value, 'next_cursor')
  return nextCursor === undefined ? null : { assets, nextCursor }
}

function parseSpecification(value: unknown): AssetGenerationSpecification | null {
  const mediaType = stringField(value, 'media_type')
  const prompt = stringField(value, 'prompt')
  const model = stringField(value, 'model')
  const mode = stringField(value, 'mode')
  const manifestVersion = numberField(value, 'manifest_version')
  const ratio = nullableStringField(value, 'ratio')
  const resolution = nullableStringField(value, 'resolution')
  const quantity = numberField(value, 'quantity')
  const durationSeconds = nullableNumberField(value, 'duration_seconds')
  if (
    (mediaType !== 'image' && mediaType !== 'video') ||
    prompt === null ||
    model === null ||
    mode === null ||
    manifestVersion === null ||
    ratio === undefined ||
    resolution === undefined ||
    quantity === null ||
    durationSeconds === undefined
  ) {
    return null
  }
  return {
    mediaType,
    prompt,
    model,
    mode,
    manifestVersion,
    ratio,
    resolution,
    quantity,
    durationSeconds
  }
}

function parsePrivateOrigin(value: unknown): AssetPrivateOrigin | null {
  const source = record(value)
  if (source === null) return null
  const sessionId = stringField(value, 'session_id')
  const sessionName = nullableStringField(value, 'session_name')
  const taskId = stringField(value, 'task_id')
  const slotIndex = numberField(value, 'slot_index')
  const specification = parseSpecification(record(value)?.['specification'])
  if (
    !sessionId ||
    ('session_name' in source && sessionName === undefined) ||
    !taskId ||
    slotIndex === null ||
    specification === null
  ) {
    return null
  }
  return { sessionId, sessionName: sessionName ?? null, taskId, slotIndex, specification }
}

function parseDetail(value: unknown): AssetDetailView | null {
  const source = record(value)
  if (source === null || !Array.isArray(source['siblings'])) return null
  const asset = parseAsset(source['asset'])
  if (asset === null) return null
  const siblings: MediaAssetView[] = []
  for (const item of source['siblings']) {
    const parsed = parseAsset(item)
    if (parsed === null) return null
    siblings.push(parsed)
  }
  if (!('private_origin' in source) || source['private_origin'] === null) {
    return { asset, siblings, privateOrigin: null }
  }
  const privateOrigin = parsePrivateOrigin(source['private_origin'])
  return privateOrigin === null ? null : { asset, siblings, privateOrigin }
}

function query(requestValue: AssetPageRequest): Readonly<Record<string, string>> {
  return {
    ...(requestValue.cursor ? { cursor: requestValue.cursor } : {}),
    ...(requestValue.mediaType ? { media_type: requestValue.mediaType } : {}),
    ...(requestValue.creator ? { creator: requestValue.creator } : {}),
    ...(requestValue.createdSince ? { created_since: requestValue.createdSince } : {}),
    ...(requestValue.sort ? { sort: requestValue.sort } : {}),
    ...(requestValue.search ? { search: requestValue.search } : {}),
    limit: String(requestValue.limit ?? 24)
  }
}

function failure(status: number, payload: unknown): CreationApiFailure {
  if (status === 401) return { outcome: 'unauthorized' }
  if (status === 403) return { outcome: 'forbidden' }
  return { outcome: 'request-rejected', code: readErrorCode(payload) ?? 'internal_error' }
}

export function createAssetLibraryClient(serverUrl: string): {
  list(token: string, page: AssetPageRequest): Promise<CreationApiResult<AssetPage>>
  get(token: string, assetId: string): Promise<CreationApiResult<AssetDetailView>>
  loadContent(
    token: string,
    assetId: string,
    checksumSha256: string,
    options?: AssetContentOptions
  ): Promise<CreationApiResult<Blob>>
  delete(token: string, assetId: string): Promise<CreationApiResult<void>>
} {
  return {
    async list(token, page) {
      const result = await request(serverUrl, {
        method: 'GET',
        path: '/creation/assets',
        query: query(page),
        token
      })
      if (result.outcome !== 'succeeded') return result
      const parsed = parsePage(result.payload)
      return parsed === null
        ? { outcome: 'network-failure' }
        : { outcome: 'succeeded', value: parsed }
    },
    async get(token, assetId) {
      const result = await request(serverUrl, {
        method: 'GET',
        path: `/creation/assets/${encodeURIComponent(assetId)}`,
        token
      })
      if (result.outcome !== 'succeeded') return result
      const parsed = parseDetail(result.payload)
      return parsed === null
        ? { outcome: 'network-failure' }
        : { outcome: 'succeeded', value: parsed }
    },
    async loadContent(token, assetId, checksumSha256, options) {
      let response: Response
      try {
        response = await fetch(
          new URL(`/creation/assets/${encodeURIComponent(assetId)}/content`, serverUrl),
          {
            method: 'GET',
            redirect: 'error',
            headers: { Authorization: `Bearer ${token}` },
            signal: options?.signal
          }
        )
      } catch {
        return options?.signal?.aborted
          ? { outcome: 'request-rejected', code: 'download_cancelled' }
          : { outcome: 'network-failure' }
      }
      if (!response.ok) {
        let payload: unknown
        try {
          payload = await response.json()
        } catch {
          return { outcome: 'network-failure' }
        }
        return failure(response.status, payload)
      }
      const streamedChecksum = response.headers.get('X-Content-SHA-256')?.toLowerCase()
      if (!streamedChecksum) return { outcome: 'request-rejected', code: 'checksum_missing' }
      if (streamedChecksum !== checksumSha256.toLowerCase()) {
        return { outcome: 'request-rejected', code: 'checksum_mismatch' }
      }
      try {
        const blob = await response.blob()
        if (options?.signal?.aborted) {
          return { outcome: 'request-rejected', code: 'download_cancelled' }
        }
        return { outcome: 'succeeded', value: blob }
      } catch {
        return options?.signal?.aborted
          ? { outcome: 'request-rejected', code: 'download_cancelled' }
          : { outcome: 'network-failure' }
      }
    },
    async delete(token, assetId) {
      const result = await request(serverUrl, {
        method: 'DELETE',
        path: `/creation/assets/${encodeURIComponent(assetId)}`,
        token
      })
      return result.outcome === 'succeeded' ? { outcome: 'succeeded', value: undefined } : result
    }
  }
}
