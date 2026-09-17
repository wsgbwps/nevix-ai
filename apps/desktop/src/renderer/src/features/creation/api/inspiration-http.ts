import {
  loadVerifiedContent,
  parseAsset,
  parseReference,
  parseSpecification,
  type AssetContentOptions,
  type AssetGenerationSpecification,
  type AssetMediaType,
  type AssetReferenceSummary,
  type MediaAssetView
} from './asset-library-http'
import { request, type CreationApiResult, type CreationSessionView } from './go-creation-http'

export interface PublicationCapabilities {
  readonly canWithdraw: boolean
  readonly canCreateSimilar: boolean
}

export interface PublicationView {
  readonly id: string
  readonly sourceAssetId: string
  readonly publisher: { readonly id: string; readonly displayName: string }
  readonly mediaType: AssetMediaType
  readonly mimeType: string
  readonly byteSize: number
  readonly checksumSha256: string
  readonly widthPx: number | null
  readonly heightPx: number | null
  readonly durationMs: number | null
  readonly publishedAt: string
  readonly restricted: boolean
  readonly capabilities: PublicationCapabilities
}

export type InspirationItem =
  | { readonly type: 'publication'; readonly publication: PublicationView }
  | { readonly type: 'asset'; readonly asset: MediaAssetView }

export interface InspirationPageRequest {
  readonly cursor?: string | null
  readonly mediaType?: AssetMediaType
  readonly creator?: string
  readonly search?: string
  readonly limit?: number
}

export interface InspirationPage {
  readonly items: readonly InspirationItem[]
  readonly nextCursor: string | null
}

export interface PublicationDetailView {
  readonly type: 'publication'
  readonly publication: PublicationView
  readonly specification: AssetGenerationSpecification
  readonly references: readonly AssetReferenceSummary[]
}

export interface InspirationAssetDetailView {
  readonly type: 'asset'
  readonly asset: MediaAssetView
  readonly specification: AssetGenerationSpecification
  readonly references: readonly AssetReferenceSummary[]
  readonly publication: PublicationView | null
}

export type InspirationDetailView = PublicationDetailView | InspirationAssetDetailView

export interface SimilarMaterialView {
  readonly id: string
  readonly sessionId: string
  readonly kind: 'image' | 'video' | 'audio'
  readonly fileName: string
  readonly mimeType: string
  readonly byteSize: number
  readonly checksumSha256: string
  readonly widthPx: number | null
  readonly heightPx: number | null
  readonly durationMs: number | null
  readonly claimsVersion: number
  readonly createdAt: string
}

export interface PublicationSimilarResult {
  readonly session: CreationSessionView
  readonly materials: readonly SimilarMaterialView[]
  readonly specification: AssetGenerationSpecification
  readonly submissionBlocked: boolean
}

export interface InspirationPorts {
  readonly listInspiration: (
    request: InspirationPageRequest
  ) => Promise<CreationApiResult<InspirationPage>>
  readonly getInspirationDetail: (
    item: InspirationItem
  ) => Promise<CreationApiResult<InspirationDetailView>>
  readonly loadInspirationContent: (
    item: InspirationItem,
    options?: AssetContentOptions
  ) => Promise<CreationApiResult<Blob>>
  readonly loadInspirationReferencePreview: (
    item: InspirationItem,
    referenceId: string
  ) => Promise<CreationApiResult<{ readonly url: string; readonly expiresAt: string }>>
  readonly publishAsset: (
    assetId: string,
    idempotencyKey: string
  ) => Promise<CreationApiResult<PublicationView>>
  readonly withdrawPublication: (publicationId: string) => Promise<CreationApiResult<void>>
  readonly createPublicationSimilar: (
    publicationId: string,
    idempotencyKey: string
  ) => Promise<CreationApiResult<PublicationSimilarResult>>
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

function nullableNumberField(value: unknown, field: string): number | null | undefined {
  const source = record(value)
  if (source === null || !(field in source) || source[field] === null) return null
  const candidate = source[field]
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined
}

function parsePublication(value: unknown): PublicationView | null {
  const source = record(value)
  const id = stringField(value, 'id')
  const sourceAssetId = stringField(value, 'source_asset_id')
  const publisherId = stringField(source?.['publisher'], 'id')
  const displayName = stringField(source?.['publisher'], 'display_name')
  const mediaType = stringField(value, 'media_type')
  const mimeType = stringField(value, 'mime_type')
  const byteSize = numberField(value, 'byte_size')
  const checksumSha256 = stringField(value, 'checksum_sha256')
  const widthPx = nullableNumberField(value, 'width_px')
  const heightPx = nullableNumberField(value, 'height_px')
  const durationMs = nullableNumberField(value, 'duration_ms')
  const publishedAt = stringField(value, 'published_at')
  const restricted = source?.['restricted']
  const capabilities = record(source?.['capabilities'])
  const canWithdraw = capabilities?.['can_withdraw']
  const canCreateSimilar = capabilities?.['can_create_similar']
  if (
    !id ||
    !sourceAssetId ||
    !publisherId ||
    displayName === null ||
    (mediaType !== 'image' && mediaType !== 'video') ||
    !mimeType ||
    byteSize === null ||
    !checksumSha256 ||
    widthPx === undefined ||
    heightPx === undefined ||
    durationMs === undefined ||
    !publishedAt ||
    typeof restricted !== 'boolean' ||
    typeof canWithdraw !== 'boolean' ||
    typeof canCreateSimilar !== 'boolean'
  ) {
    return null
  }
  return {
    id,
    sourceAssetId,
    publisher: { id: publisherId, displayName },
    mediaType,
    mimeType,
    byteSize,
    checksumSha256,
    widthPx,
    heightPx,
    durationMs,
    publishedAt,
    restricted,
    capabilities: { canWithdraw, canCreateSimilar }
  }
}

function parsePage(value: unknown): InspirationPage | null {
  const source = record(value)
  if (source === null || !Array.isArray(source['items'])) return null
  const items: InspirationItem[] = []
  for (const item of source['items']) {
    const itemSource = record(item)
    if (itemSource?.['type'] === 'publication') {
      const publication = parsePublication(itemSource['publication'])
      if (publication === null) return null
      items.push({ type: 'publication', publication })
      continue
    }
    if (itemSource?.['type'] === 'asset') {
      const asset = parseAsset(itemSource['asset'])
      if (asset === null) return null
      items.push({ type: 'asset', asset })
      continue
    }
    return null
  }
  const nextCursor = source['next_cursor']
  return nextCursor === null || typeof nextCursor === 'string' ? { items, nextCursor } : null
}

function parseReferences(value: unknown): readonly AssetReferenceSummary[] | null {
  if (!Array.isArray(value)) return null
  const references: AssetReferenceSummary[] = []
  for (const entry of value) {
    const parsed = parseReference(entry)
    if (parsed === null) return null
    references.push(parsed)
  }
  return references
}

function parsePublicationDetail(value: unknown): PublicationDetailView | null {
  const source = record(value)
  const publication = parsePublication(source?.['publication'])
  const specification = parseSpecification(source?.['specification'])
  const references = parseReferences(source?.['references'])
  return publication && specification && references
    ? { type: 'publication', publication, specification, references }
    : null
}

function parseAssetDetail(value: unknown): InspirationAssetDetailView | null {
  const source = record(value)
  const asset = parseAsset(source?.['asset'])
  const specification = parseSpecification(source?.['specification'])
  const references = parseReferences(source?.['references'])
  const publicationValue = source?.['publication']
  const publication =
    publicationValue === null || publicationValue === undefined
      ? null
      : parsePublication(publicationValue)
  if (publicationValue !== null && publicationValue !== undefined && publication === null) {
    return null
  }
  return asset && specification && references
    ? { type: 'asset', asset, specification, references, publication }
    : null
}

function parseSession(value: unknown): CreationSessionView | null {
  const id = stringField(value, 'id')
  const name = stringField(value, 'name')
  const createdAt = stringField(value, 'created_at')
  const updatedAt = stringField(value, 'updated_at')
  return id && name !== null && createdAt && updatedAt ? { id, name, createdAt, updatedAt } : null
}

function parseMaterial(value: unknown): SimilarMaterialView | null {
  const id = stringField(value, 'id')
  const sessionId = stringField(value, 'session_id')
  const kind = stringField(value, 'kind')
  const fileName = stringField(value, 'file_name')
  const mimeType = stringField(value, 'mime_type')
  const byteSize = numberField(value, 'byte_size')
  const checksumSha256 = stringField(value, 'checksum_sha256')
  const widthPx = nullableNumberField(value, 'width_px')
  const heightPx = nullableNumberField(value, 'height_px')
  const durationMs = nullableNumberField(value, 'duration_ms')
  const claimsVersion = numberField(value, 'claims_version')
  const createdAt = stringField(value, 'created_at')
  if (
    !id ||
    !sessionId ||
    !['image', 'video', 'audio'].includes(kind ?? '') ||
    !fileName ||
    !mimeType ||
    byteSize === null ||
    !checksumSha256 ||
    widthPx === undefined ||
    heightPx === undefined ||
    durationMs === undefined ||
    claimsVersion === null ||
    !createdAt
  ) {
    return null
  }
  return {
    id,
    sessionId,
    kind: kind as SimilarMaterialView['kind'],
    fileName,
    mimeType,
    byteSize,
    checksumSha256,
    widthPx,
    heightPx,
    durationMs,
    claimsVersion,
    createdAt
  }
}

function parseSimilar(value: unknown): PublicationSimilarResult | null {
  const source = record(value)
  const session = parseSession(source?.['session'])
  const specification = parseSpecification(source?.['specification'])
  const submissionBlocked = source?.['submission_blocked']
  if (
    session === null ||
    specification === null ||
    typeof submissionBlocked !== 'boolean' ||
    !Array.isArray(source?.['materials'])
  ) {
    return null
  }
  const materials: SimilarMaterialView[] = []
  for (const entry of source['materials']) {
    const material = parseMaterial(entry)
    if (material === null) return null
    materials.push(material)
  }
  const materialsById = new Map(materials.map((material) => [material.id, material]))
  if (
    materialsById.size !== materials.length ||
    materials.some((material) => material.sessionId !== session.id) ||
    specification.references.length !== materials.length ||
    specification.references.some((reference) => {
      const material = materialsById.get(reference.materialId)
      return (
        material === undefined ||
        material.kind !== reference.kind ||
        material.claimsVersion !== reference.claimsVersion
      )
    })
  ) {
    return null
  }
  return { session, specification, materials, submissionBlocked }
}

function itemPath(item: InspirationItem): string {
  return item.type === 'publication'
    ? `/creation/publications/${encodeURIComponent(item.publication.id)}`
    : `/creation/inspiration/assets/${encodeURIComponent(item.asset.id)}`
}

export function createInspirationClient(serverUrl: string): {
  list(token: string, page: InspirationPageRequest): Promise<CreationApiResult<InspirationPage>>
  get(token: string, item: InspirationItem): Promise<CreationApiResult<InspirationDetailView>>
  loadContent(
    token: string,
    item: InspirationItem,
    options?: AssetContentOptions
  ): Promise<CreationApiResult<Blob>>
  loadReferencePreview(
    token: string,
    item: InspirationItem,
    referenceId: string
  ): Promise<CreationApiResult<{ readonly url: string; readonly expiresAt: string }>>
  publish(
    token: string,
    assetId: string,
    idempotencyKey: string
  ): Promise<CreationApiResult<PublicationView>>
  withdraw(token: string, publicationId: string): Promise<CreationApiResult<void>>
  createSimilar(
    token: string,
    publicationId: string,
    idempotencyKey: string
  ): Promise<CreationApiResult<PublicationSimilarResult>>
} {
  return {
    async list(token, page) {
      const result = await request(serverUrl, {
        method: 'GET',
        path: '/creation/inspiration',
        query: {
          ...(page.cursor ? { cursor: page.cursor } : {}),
          ...(page.mediaType ? { media_type: page.mediaType } : {}),
          ...(page.creator?.trim() ? { creator: page.creator.trim() } : {}),
          ...(page.search?.trim() ? { search: page.search.trim() } : {}),
          limit: String(page.limit ?? 24)
        },
        token
      })
      if (result.outcome !== 'succeeded') return result
      const parsed = parsePage(result.payload)
      return parsed ? { outcome: 'succeeded', value: parsed } : { outcome: 'network-failure' }
    },
    async get(token, item) {
      const result = await request(serverUrl, { method: 'GET', path: itemPath(item), token })
      if (result.outcome !== 'succeeded') return result
      const parsed =
        item.type === 'publication'
          ? parsePublicationDetail(result.payload)
          : parseAssetDetail(result.payload)
      return parsed ? { outcome: 'succeeded', value: parsed } : { outcome: 'network-failure' }
    },
    loadContent(token, item, options) {
      const media = item.type === 'publication' ? item.publication : item.asset
      return loadVerifiedContent(
        serverUrl,
        `${itemPath(item)}/content`,
        token,
        media.checksumSha256,
        options
      )
    },
    async loadReferencePreview(token, item, referenceId) {
      const result = await request(serverUrl, {
        method: 'GET',
        path: `${itemPath(item)}/references/${encodeURIComponent(referenceId)}/preview-url`,
        token
      })
      if (result.outcome !== 'succeeded') return result
      const url = stringField(result.payload, 'url')
      const expiresAt = stringField(result.payload, 'expires_at')
      return url && expiresAt
        ? { outcome: 'succeeded', value: { url, expiresAt } }
        : { outcome: 'network-failure' }
    },
    async publish(token, assetId, idempotencyKey) {
      const result = await request(serverUrl, {
        method: 'POST',
        path: `/creation/assets/${encodeURIComponent(assetId)}/publication`,
        body: { idempotency_key: idempotencyKey },
        token
      })
      if (result.outcome !== 'succeeded') return result
      const publication = parsePublication(record(result.payload)?.['publication'])
      return publication
        ? { outcome: 'succeeded', value: publication }
        : { outcome: 'network-failure' }
    },
    async withdraw(token, publicationId) {
      const result = await request(serverUrl, {
        method: 'DELETE',
        path: `/creation/publications/${encodeURIComponent(publicationId)}`,
        token
      })
      return result.outcome === 'succeeded' ? { outcome: 'succeeded', value: undefined } : result
    },
    async createSimilar(token, publicationId, idempotencyKey) {
      const result = await request(serverUrl, {
        method: 'POST',
        path: `/creation/publications/${encodeURIComponent(publicationId)}/create-similar`,
        body: { idempotency_key: idempotencyKey },
        token
      })
      if (result.outcome !== 'succeeded') return result
      const parsed = parseSimilar(result.payload)
      return parsed ? { outcome: 'succeeded', value: parsed } : { outcome: 'network-failure' }
    }
  }
}
