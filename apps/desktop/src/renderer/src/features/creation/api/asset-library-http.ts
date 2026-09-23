import type { CreationApiFailure, CreationApiResult } from './go-creation-http'
import { fetchDisplayUrl, readErrorCode, request } from './go-creation-http'

export type AssetMediaType = 'image' | 'video'
export type AssetSort = 'newest' | 'oldest'
export type RestrictionState = 'active' | 'released' | null

export interface AssetCreatorView {
  readonly id: string
  readonly displayName: string
}

export interface AssetCapabilities {
  readonly canDelete: boolean
  readonly canCreateSimilar: boolean
  readonly canPublish: boolean
  readonly canRestrict: boolean
  readonly canRelease: boolean
}

export interface AssetPublicationSummary {
  readonly id: string
  readonly publishedAt: string
  readonly restricted: boolean
  readonly restrictionState: RestrictionState
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
  readonly restricted: boolean
  readonly restrictionState: RestrictionState
  readonly publication: AssetPublicationSummary | null
  readonly capabilities: AssetCapabilities
}

export interface AssetPageRequest {
  readonly cursor?: string | null
  readonly mediaType?: AssetMediaType
  readonly createdSince?: string
  /** Exclusive upper bound; send the instant after the inclusive end date. */
  readonly createdUntil?: string
  readonly sort?: AssetSort
  /** Frozen Generation Specification facets; each repeats its own parameter. */
  readonly modes?: readonly string[]
  readonly ratios?: readonly string[]
  readonly resolutions?: readonly string[]
  readonly limit?: number
}

/**
 * The values a facet can take for the requested media, published by the list
 * endpoint straight from the capability contract: not read off the page of
 * results, and independent of the provider connection being usable.
 */
export interface AssetFacetVocabulary {
  readonly modes: readonly string[]
  readonly ratios: readonly string[]
  readonly resolutions: readonly string[]
}

export interface AssetPage {
  readonly assets: readonly MediaAssetView[]
  readonly nextCursor: string | null
  readonly facets: AssetFacetVocabulary | null
}

export interface AssetGenerationSpecification {
  readonly schemaVersion: number
  readonly mediaType: AssetMediaType
  readonly prompt: string
  readonly model: string
  readonly mode: string
  readonly manifestVersion: number
  readonly ratio: string | null
  readonly resolution: string | null
  readonly quantity: number
  readonly durationSeconds: number | null
  readonly references: readonly AssetSpecificationReference[]
}

export interface AssetSpecificationReference {
  readonly materialId: string
  readonly role: 'reference' | 'first_frame' | 'last_frame' | 'omni'
  readonly kind: 'image' | 'video' | 'audio'
  readonly claimsVersion: number
}

export interface AssetReferenceSummary {
  readonly id: string
  readonly role: AssetSpecificationReference['role']
  readonly kind: AssetSpecificationReference['kind']
  readonly fileName: string
  readonly mimeType: string
  readonly byteSize: number
  readonly widthPx: number | null
  readonly heightPx: number | null
  readonly durationMs: number | null
  readonly claimsVersion: number
}

export interface AssetPrivateOrigin {
  readonly sessionId: string
  readonly sessionName: string | null
  readonly taskId: string
  readonly slotIndex: number
  readonly specification: AssetGenerationSpecification
  readonly references: readonly AssetReferenceSummary[]
}

export interface AssetDetailView {
  readonly asset: MediaAssetView
  readonly siblings: readonly MediaAssetView[]
  readonly privateOrigin: AssetPrivateOrigin | null
}

export interface AssetContentOptions {
  readonly signal?: AbortSignal
  readonly expectedByteSize?: number
}

/**
 * Which fixed variant a card asks for: the wall's lightweight thumbnail, or
 * the detail's full preview. The renderer never composes the size — Go signs
 * one exact object at one fixed transformation.
 */
export type AssetDisplayPurpose = 'thumbnail' | 'preview'

/**
 * What a media element paints from: Go's short-lived display grant, handed to
 * the element directly. Nothing on the wall or in a detail streams a complete
 * original through Go first.
 */
export interface DisplayGrant {
  readonly url: string
  readonly expiresAt: string
}

export interface AssetDisplayOptions {
  /** Aborting must stop the read, not just ignore its answer. */
  readonly signal?: AbortSignal
}

export interface AssetLibraryPorts {
  readonly listAssets: (request: AssetPageRequest) => Promise<CreationApiResult<AssetPage>>
  readonly getAsset: (assetId: string) => Promise<CreationApiResult<AssetDetailView>>
  /** Fetches one visible Asset's short-lived display grant (ADR-0014). */
  readonly loadAssetDisplay: (
    assetId: string,
    purpose: AssetDisplayPurpose,
    options?: AssetDisplayOptions
  ) => Promise<CreationApiResult<DisplayGrant>>
  /** Streams the original bytes through Go; display never uses this path. */
  readonly downloadAssetContent: (
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

function restrictionStateField(value: unknown): RestrictionState | undefined {
  const source = record(value)
  if (source === null || !('restriction_state' in source)) return undefined
  const candidate = source['restriction_state']
  return candidate === null || candidate === 'active' || candidate === 'released'
    ? candidate
    : undefined
}

function parseCapabilities(value: unknown): AssetCapabilities | null {
  const source = record(value)
  if (source === null) return null
  const canDelete = source['can_delete']
  const canCreateSimilar = source['can_create_similar']
  const canPublish = source['can_publish']
  const canRestrict = source['can_restrict']
  const canRelease = source['can_release']
  return typeof canDelete === 'boolean' &&
    typeof canCreateSimilar === 'boolean' &&
    typeof canPublish === 'boolean' &&
    typeof canRestrict === 'boolean' &&
    typeof canRelease === 'boolean'
    ? { canDelete, canCreateSimilar, canPublish, canRestrict, canRelease }
    : null
}

export function parseAsset(value: unknown): MediaAssetView | null {
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
  const restricted = record(value)?.['restricted']
  const restrictionState = restrictionStateField(value)
  const publicationValue = record(value)?.['publication']
  let publication: AssetPublicationSummary | null = null
  if (publicationValue !== null && publicationValue !== undefined) {
    const publicationId = stringField(publicationValue, 'id')
    const publishedAt = stringField(publicationValue, 'published_at')
    const publicationRestricted = record(publicationValue)?.['restricted']
    const publicationRestrictionState = restrictionStateField(publicationValue)
    if (
      !publicationId ||
      !publishedAt ||
      typeof publicationRestricted !== 'boolean' ||
      publicationRestrictionState === undefined
    ) {
      return null
    }
    publication = {
      id: publicationId,
      publishedAt,
      restricted: publicationRestricted,
      restrictionState: publicationRestrictionState
    }
  }
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
    typeof restricted !== 'boolean' ||
    restrictionState === undefined ||
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
    restricted,
    restrictionState,
    publication,
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
  if (nextCursor === undefined) return null
  const facets = source['facets'] === null ? null : parseFacets(source['facets'])
  if (facets === undefined) return null
  return { assets, nextCursor, facets }
}

function parseFacets(value: unknown): AssetFacetVocabulary | undefined {
  const source = record(value)
  if (source === null) return undefined
  const modes = stringListField(source, 'modes')
  const ratios = stringListField(source, 'ratios')
  const resolutions = stringListField(source, 'resolutions')
  if (modes === null || ratios === null || resolutions === null) return undefined
  return { modes, ratios, resolutions }
}

function stringListField(source: Record<string, unknown>, field: string): readonly string[] | null {
  const raw = source[field]
  if (!Array.isArray(raw)) return null
  const values: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') return null
    values.push(entry)
  }
  return values
}

export function parseSpecification(value: unknown): AssetGenerationSpecification | null {
  const source = record(value)
  const schemaVersion = numberField(value, 'schema_version')
  const mediaType = stringField(value, 'media_type')
  const prompt = stringField(value, 'prompt')
  const model = stringField(value, 'model')
  const mode = stringField(value, 'mode')
  const manifestVersion = numberField(value, 'manifest_version')
  const ratio = nullableStringField(value, 'ratio')
  const resolution = nullableStringField(value, 'resolution')
  const quantity = numberField(value, 'quantity')
  const durationSeconds = nullableNumberField(value, 'duration_seconds')
  if (source === null || !Array.isArray(source['references'])) return null
  const references: AssetSpecificationReference[] = []
  for (const entry of source['references']) {
    const materialId = stringField(entry, 'material_id')
    const role = stringField(entry, 'role')
    const kind = stringField(entry, 'kind')
    const claimsVersion = numberField(entry, 'claims_version')
    if (
      !materialId ||
      claimsVersion === null ||
      !['reference', 'first_frame', 'last_frame', 'omni'].includes(role ?? '') ||
      !['image', 'video', 'audio'].includes(kind ?? '')
    ) {
      return null
    }
    references.push({
      materialId,
      role: role as AssetSpecificationReference['role'],
      kind: kind as AssetSpecificationReference['kind'],
      claimsVersion
    })
  }
  if (
    schemaVersion === null ||
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
    schemaVersion,
    mediaType,
    prompt,
    model,
    mode,
    manifestVersion,
    ratio,
    resolution,
    quantity,
    durationSeconds,
    references
  }
}

export function parseReference(value: unknown): AssetReferenceSummary | null {
  const id = stringField(value, 'id')
  const role = stringField(value, 'role')
  const kind = stringField(value, 'kind')
  const fileName = stringField(value, 'file_name')
  const mimeType = stringField(value, 'mime_type')
  const byteSize = numberField(value, 'byte_size')
  const widthPx = nullableNumberField(value, 'width_px')
  const heightPx = nullableNumberField(value, 'height_px')
  const durationMs = nullableNumberField(value, 'duration_ms')
  const claimsVersion = numberField(value, 'claims_version')
  if (
    !id ||
    !fileName ||
    !mimeType ||
    byteSize === null ||
    widthPx === undefined ||
    heightPx === undefined ||
    durationMs === undefined ||
    claimsVersion === null ||
    !['reference', 'first_frame', 'last_frame', 'omni'].includes(role ?? '') ||
    !['image', 'video', 'audio'].includes(kind ?? '')
  ) {
    return null
  }
  return {
    id,
    role: role as AssetReferenceSummary['role'],
    kind: kind as AssetReferenceSummary['kind'],
    fileName,
    mimeType,
    byteSize,
    widthPx,
    heightPx,
    durationMs,
    claimsVersion
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
  if (!Array.isArray(source['references'])) return null
  const references: AssetReferenceSummary[] = []
  for (const entry of source['references']) {
    const parsed = parseReference(entry)
    if (parsed === null) return null
    references.push(parsed)
  }
  if (
    !sessionId ||
    ('session_name' in source && sessionName === undefined) ||
    !taskId ||
    slotIndex === null ||
    specification === null
  ) {
    return null
  }
  return {
    sessionId,
    sessionName: sessionName ?? null,
    taskId,
    slotIndex,
    specification,
    references
  }
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

function query(
  requestValue: AssetPageRequest
): Readonly<Record<string, string | readonly string[]>> {
  return {
    ...(requestValue.cursor ? { cursor: requestValue.cursor } : {}),
    ...(requestValue.mediaType ? { media_type: requestValue.mediaType } : {}),
    ...(requestValue.createdSince ? { created_since: requestValue.createdSince } : {}),
    ...(requestValue.createdUntil ? { created_until: requestValue.createdUntil } : {}),
    ...(requestValue.sort ? { sort: requestValue.sort } : {}),
    ...(requestValue.modes?.length ? { mode: requestValue.modes } : {}),
    ...(requestValue.ratios?.length ? { ratio: requestValue.ratios } : {}),
    ...(requestValue.resolutions?.length ? { resolution: requestValue.resolutions } : {}),
    limit: String(requestValue.limit ?? 24)
  }
}

function failure(status: number, payload: unknown): CreationApiFailure {
  if (status === 401) return { outcome: 'unauthorized' }
  if (status === 403) return { outcome: 'forbidden' }
  return { outcome: 'request-rejected', code: readErrorCode(payload) ?? 'internal_error' }
}

export async function loadVerifiedContent(
  serverUrl: string,
  path: string,
  token: string,
  checksumSha256: string,
  options?: AssetContentOptions
): Promise<CreationApiResult<Blob>> {
  let response: Response
  try {
    response = await fetch(new URL(path, serverUrl), {
      method: 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}` },
      signal: options?.signal
    })
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
    return options?.expectedByteSize !== undefined && blob.size !== options.expectedByteSize
      ? { outcome: 'request-rejected', code: 'byte_size_mismatch' }
      : { outcome: 'succeeded', value: blob }
  } catch {
    return options?.signal?.aborted
      ? { outcome: 'request-rejected', code: 'download_cancelled' }
      : { outcome: 'network-failure' }
  }
}

export function createAssetLibraryClient(serverUrl: string): {
  list(token: string, page: AssetPageRequest): Promise<CreationApiResult<AssetPage>>
  get(token: string, assetId: string): Promise<CreationApiResult<AssetDetailView>>
  loadDisplay(
    token: string,
    assetId: string,
    purpose: AssetDisplayPurpose,
    options?: AssetDisplayOptions
  ): Promise<CreationApiResult<DisplayGrant>>
  downloadContent(
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
    async loadDisplay(token, assetId, purpose, options) {
      const result = await fetchDisplayUrl(
        serverUrl,
        token,
        `/creation/assets/${encodeURIComponent(assetId)}/${purpose}-url`,
        options?.signal
      )
      return result.outcome === 'succeeded' ? { outcome: 'succeeded', value: result.value } : result
    },
    async downloadContent(token, assetId, checksumSha256, options) {
      return loadVerifiedContent(
        serverUrl,
        `/creation/assets/${encodeURIComponent(assetId)}/content`,
        token,
        checksumSha256,
        options
      )
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
