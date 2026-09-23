/**
 * The creation half of the trusted data plane (contracts/creation.yaml). JSON commands ride the
 * session's opaque Bearer token, which never enters a URL; local file bytes move through Main's
 * native upload seam. The Renderer receives only streamed display bytes and JSON views (ADR-0014) —
 * never Storage credentials, direct-upload grants, or raw local paths.
 */

export type MaterialKind = 'image' | 'video' | 'audio'

/** One creator-private draft workspace (GET /creation/sessions). */
export interface CreationSessionView {
  readonly id: string
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SessionPage {
  readonly sessions: readonly CreationSessionView[]
  /** Compound keyset cursor; null means the last page was reached. */
  readonly nextCursor: string | null
}

/** The part one reference material plays in the draft intent. */
export type DraftReferenceRole = 'reference' | 'first_frame' | 'last_frame' | 'omni'

export interface DraftReferenceView {
  readonly materialId: string
  readonly role: DraftReferenceRole
}

/** One session resource (GET /creation/sessions/{id}); drafts are device-local
 * (ADR-0017) and never ride this surface. */
export type SessionDetailView = CreationSessionView

/** One verified reference material record. */
export interface ReferenceMaterialView {
  readonly id: string
  readonly kind: MaterialKind
  readonly fileName: string
  readonly mimeType: string
  readonly byteSize: number
  readonly widthPx: number | null
  readonly heightPx: number | null
  readonly pixelCount: number | null
  readonly durationMs: number | null
  /** hex SHA-256 established during the bounded streaming put. */
  readonly checksumSha256: string
  readonly claimsVersion: number
  readonly createdAt: string
}

export interface MaterialPage {
  readonly materials: readonly ReferenceMaterialView[]
  readonly nextCursor: string | null
}

export interface CreateMaterialFromResultInput {
  readonly taskId: string
  readonly slotIndex: number
  readonly fileName: string
}

/** One creator's ephemeral display grant (ADR-0014). */
export interface DisplayUrlView {
  readonly url: string
  readonly expiresAt: string
}

const materialDeleteTimeoutMs = 30_000

/**
 * Every trusted-command failure the Workbench can observe. Clients branch on
 * the contract's `error` code only; an unmapped answer stays generic so an
 * unknown code can never fake a specific verdict.
 */
export type CreationApiFailure =
  | { readonly outcome: 'network-failure' }
  | { readonly outcome: 'unauthorized' }
  | { readonly outcome: 'forbidden' }
  | { readonly outcome: 'request-rejected'; readonly code: string }

export type CreationApiResult<T> =
  | { readonly outcome: 'succeeded'; readonly value: T }
  | CreationApiFailure

interface RequestInput {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly path: string
  /** A list value repeats the parameter (`?mode=a&mode=b`). */
  readonly query?: Readonly<Record<string, string | readonly string[]>>
  readonly body?: unknown
  readonly token: string
}

/**
 * One trusted-command round trip shared by every Creation api client in this
 * segment: bearer header, no-redirect, JSON-only failure mapping. Exported so
 * the provider-connection client's contract-failure semantics cannot drift.
 */
export async function request(
  serverUrl: string,
  input: RequestInput
): Promise<{ readonly outcome: 'succeeded'; readonly payload: unknown } | CreationApiFailure> {
  const url = new URL(input.path, serverUrl)
  for (const [name, value] of Object.entries(input.query ?? {})) {
    if (typeof value === 'string') {
      url.searchParams.set(name, value)
      continue
    }
    for (const entry of value) url.searchParams.append(name, entry)
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: input.method,
      // A trusted write must never be replayed against a redirect target.
      redirect: 'error',
      headers: {
        ...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${input.token}`
      },
      body: input.body !== undefined ? JSON.stringify(input.body) : undefined
    })
  } catch {
    return { outcome: 'network-failure' }
  }

  if (response.status === 204) return { outcome: 'succeeded', payload: undefined }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { outcome: 'network-failure' }
  }

  if (response.ok) return { outcome: 'succeeded', payload }

  const code = readErrorCode(payload)
  if (response.status === 401) return { outcome: 'unauthorized' }
  if (response.status === 403) return { outcome: 'forbidden' }
  return { outcome: 'request-rejected', code: code ?? 'internal_error' }
}

export function readErrorCode(payload: unknown): string | null {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const value = (payload as Record<string, unknown>).error
    if (typeof value === 'string') return value
  }
  return null
}

function readStringField(source: unknown, field: string): string | null {
  if (typeof source === 'object' && source !== null && field in source) {
    const value = (source as Record<string, unknown>)[field]
    if (typeof value === 'string') return value
  }
  return null
}

function readNumberOrNullField(source: unknown, field: string): number | null {
  if (typeof source !== 'object' || source === null || !(field in source)) return null
  const value = (source as Record<string, unknown>)[field]
  if (value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function parseSessionDetail(payload: unknown): SessionDetailView | null {
  if (typeof payload !== 'object' || payload === null) return null
  const id = readStringField(payload, 'id')
  const name = readStringField(payload, 'name')
  const createdAt = readStringField(payload, 'created_at')
  const updatedAt = readStringField(payload, 'updated_at')
  if (!id || name === null || !createdAt || !updatedAt) return null
  return { id, name, createdAt, updatedAt }
}

/**
 * Fetches one resource's short-lived display grant (ADR-0014). The signed URL
 * lives only in this call's returned value: it is never persisted, logged, or
 * placed in a URL the session token rides. A grant that is not an absolute
 * HTTPS URL, or that is already expired on arrival, is a failed read rather
 * than something the renderer should hand to a media element.
 */
export async function fetchDisplayUrl(
  serverUrl: string,
  token: string,
  path: string,
  signal?: AbortSignal
): Promise<CreationApiResult<DisplayUrlView>> {
  let response: Response
  try {
    response = await fetch(new URL(path, serverUrl), {
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}` },
      signal
    })
  } catch {
    return { outcome: 'network-failure' }
  }
  if (response.status === 401) return { outcome: 'unauthorized' }
  if (response.status === 403) return { outcome: 'forbidden' }
  if (response.status === 404) return { outcome: 'request-rejected', code: 'not_found' }
  if (!response.ok) return { outcome: 'network-failure' }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { outcome: 'network-failure' }
  }
  const signedUrl = readStringField(payload, 'url')
  const expiresAt = readStringField(payload, 'expires_at')
  if (!signedUrl || !expiresAt) return { outcome: 'network-failure' }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(signedUrl)
  } catch {
    return { outcome: 'network-failure' }
  }
  const expiresAtMs = Date.parse(expiresAt)
  return parsedUrl.protocol === 'https:' && Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()
    ? { outcome: 'succeeded', value: { url: signedUrl, expiresAt } }
    : { outcome: 'network-failure' }
}

export function createCreationClient(serverUrl: string): {
  listSessions(token: string, cursor?: string | null): Promise<CreationApiResult<SessionPage>>
  createSession(token: string, name?: string): Promise<CreationApiResult<CreationSessionView>>
  renameSession(
    token: string,
    sessionId: string,
    name: string
  ): Promise<CreationApiResult<CreationSessionView>>
  deleteSession(token: string, sessionId: string): Promise<CreationApiResult<void>>
  getSessionDetail(token: string, sessionId: string): Promise<CreationApiResult<SessionDetailView>>
  listMaterials(
    token: string,
    sessionId: string,
    cursor?: string | null
  ): Promise<CreationApiResult<MaterialPage>>
  uploadMaterial(sessionId: string, file: File): Promise<CreationApiResult<ReferenceMaterialView>>
  createMaterialFromResult(
    token: string,
    sessionId: string,
    input: CreateMaterialFromResultInput
  ): Promise<CreationApiResult<ReferenceMaterialView>>
  deleteMaterial(token: string, materialId: string): Promise<CreationApiResult<void>>
  /** Fetches one owned image material's short-lived presigned thumbnail URL. */
  loadMaterialThumbnailUrl(
    token: string,
    materialId: string
  ): Promise<CreationApiResult<DisplayUrlView>>
  /** Fetches one owned material's short-lived presigned preview URL. */
  loadMaterialPreviewUrl(
    token: string,
    materialId: string
  ): Promise<CreationApiResult<DisplayUrlView>>
} {
  async function listPage<T>(
    parse: (payload: unknown) => T | null,
    path: string,
    token: string,
    cursor?: string | null
  ): Promise<CreationApiResult<T>> {
    const result = await request(serverUrl, {
      method: 'GET',
      path,
      query: { limit: '50', ...(cursor ? { cursor } : {}) },
      token
    })
    if (result.outcome !== 'succeeded') return result
    const parsed = parse(result.payload)
    return parsed ? { outcome: 'succeeded', value: parsed } : { outcome: 'network-failure' }
  }

  function parseSessionPage(payload: unknown): SessionPage | null {
    if (typeof payload !== 'object' || payload === null || !('sessions' in payload)) return null
    const rawSessions = (payload as Record<string, unknown>).sessions
    if (!Array.isArray(rawSessions)) return null
    const sessions: CreationSessionView[] = []
    for (const entry of rawSessions) {
      const id = readStringField(entry, 'id')
      if (!id) return null
      const name = readStringField(entry, 'name')
      const createdAt = readStringField(entry, 'created_at')
      const updatedAt = readStringField(entry, 'updated_at')
      if (name === null || !createdAt || !updatedAt) return null
      sessions.push({ id, name, createdAt, updatedAt })
    }
    return { sessions, nextCursor: readCursor(payload) }
  }

  function parseMaterialPage(payload: unknown): MaterialPage | null {
    if (typeof payload !== 'object' || payload === null || !('materials' in payload)) return null
    const rawMaterials = (payload as Record<string, unknown>).materials
    if (!Array.isArray(rawMaterials)) return null
    const materials: ReferenceMaterialView[] = []
    for (const entry of rawMaterials) {
      const view = parseMaterial(entry)
      if (!view) return null
      materials.push(view)
    }
    return { materials, nextCursor: readCursor(payload) }
  }

  function readCursor(payload: unknown): string | null {
    if (typeof payload !== 'object' || payload === null) return null
    const value = (payload as Record<string, unknown>).next_cursor
    return typeof value === 'string' ? value : null
  }

  function parseMaterial(entry: unknown): ReferenceMaterialView | null {
    const id = readStringField(entry, 'id')
    const kindRaw = readStringField(entry, 'kind')
    const kind = kindRaw === 'image' || kindRaw === 'video' || kindRaw === 'audio' ? kindRaw : null
    const fileName = readStringField(entry, 'file_name')
    const mimeType = readStringField(entry, 'mime_type')
    if (!id || !kind || fileName === null || !mimeType) return null

    let byteSize: number | null = null
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).byte_size === 'number'
    ) {
      byteSize = (entry as Record<string, unknown>).byte_size as number
    }
    const checksum = readStringField(entry, 'checksum_sha256')
    const createdAt = readStringField(entry, 'created_at')
    if (byteSize === null || !checksum || !createdAt) return null

    const claimsVersionRaw = readNumberOrNullField(entry, 'claims_version')
    if (claimsVersionRaw === null) return null
    return {
      id,
      kind,
      fileName,
      mimeType,
      byteSize,
      widthPx: readNumberOrNullField(entry, 'width_px'),
      heightPx: readNumberOrNullField(entry, 'height_px'),
      pixelCount: readNumberOrNullField(entry, 'pixel_count'),
      durationMs: readNumberOrNullField(entry, 'duration_ms'),
      checksumSha256: checksum,
      claimsVersion: claimsVersionRaw,
      createdAt
    }
  }

  return {
    listSessions: (token, cursor) =>
      listPage(parseSessionPage, '/creation/sessions', token, cursor),
    getSessionDetail: async (token, sessionId) => {
      const result = await request(serverUrl, {
        method: 'GET',
        path: `/creation/sessions/${sessionId}`,
        token
      })
      if (result.outcome !== 'succeeded') return result
      const detail = parseSessionDetail(result.payload)
      return detail ? { outcome: 'succeeded', value: detail } : { outcome: 'network-failure' }
    },
    createSession: async (token, name) => {
      const result = await request(serverUrl, {
        method: 'POST',
        path: '/creation/sessions',
        body: { ...(name && name.length > 0 ? { name } : {}) },
        token
      })
      if (result.outcome !== 'succeeded') return result
      const id = readStringField(result.payload, 'id')
      const storedName = readStringField(result.payload, 'name') ?? ''
      const createdAt = readStringField(result.payload, 'created_at')
      const updatedAt = readStringField(result.payload, 'updated_at')
      return id && createdAt && updatedAt
        ? { outcome: 'succeeded', value: { id, name: storedName, createdAt, updatedAt } }
        : { outcome: 'network-failure' }
    },
    renameSession: async (token, sessionId, name) => {
      const result = await request(serverUrl, {
        method: 'PATCH',
        path: `/creation/sessions/${sessionId}`,
        body: { name },
        token
      })
      if (result.outcome !== 'succeeded') return result
      const id = readStringField(result.payload, 'id')
      const updatedName = readStringField(result.payload, 'name')
      const updatedAt = readStringField(result.payload, 'updated_at')
      return id && updatedName !== null && updatedAt
        ? {
            outcome: 'succeeded',
            value: {
              id,
              name: updatedName,
              // created_at rides untouched through renames; reuse the payload copy.
              createdAt: readStringField(result.payload, 'created_at') ?? '',
              updatedAt
            }
          }
        : { outcome: 'network-failure' }
    },
    deleteSession: async (token, sessionId) => {
      const url = new URL(`/creation/sessions/${sessionId}`, serverUrl)
      let response: Response
      try {
        response = await fetch(url, {
          method: 'DELETE',
          redirect: 'error',
          headers: { Authorization: `Bearer ${token}` }
        })
      } catch {
        return { outcome: 'network-failure' }
      }
      if (response.ok) return { outcome: 'succeeded', value: undefined }
      if (response.status === 401) return { outcome: 'unauthorized' }
      if (response.status === 403) return { outcome: 'forbidden' }
      return { outcome: 'request-rejected', code: 'not_found' }
    },
    listMaterials: (token, sessionId, cursor) =>
      listPage(parseMaterialPage, `/creation/sessions/${sessionId}/materials`, token, cursor),
    uploadMaterial: (sessionId, file) =>
      window.api.creation.uploadReferenceMaterial(crypto.randomUUID(), sessionId, file),
    createMaterialFromResult: async (token, sessionId, input) => {
      const result = await request(serverUrl, {
        method: 'POST',
        path: `/creation/sessions/${sessionId}/materials/from-result`,
        body: {
          task_id: input.taskId,
          slot_index: input.slotIndex,
          file_name: input.fileName
        },
        token
      })
      if (result.outcome !== 'succeeded') return result
      const material = parseMaterial(result.payload)
      return material ? { outcome: 'succeeded', value: material } : { outcome: 'network-failure' }
    },
    deleteMaterial: async (token, materialId) => {
      const url = new URL(`/creation/materials/${encodeURIComponent(materialId)}`, serverUrl)
      let response: Response
      try {
        response = await fetch(url, {
          method: 'DELETE',
          redirect: 'error',
          signal: AbortSignal.timeout(materialDeleteTimeoutMs),
          headers: { Authorization: `Bearer ${token}` }
        })
      } catch {
        return { outcome: 'network-failure' }
      }
      if (response.ok) return { outcome: 'succeeded', value: undefined }
      if (response.status === 401) return { outcome: 'unauthorized' }
      if (response.status === 403) return { outcome: 'forbidden' }
      if (response.status === 404) return { outcome: 'request-rejected', code: 'not_found' }
      return { outcome: 'network-failure' }
    },
    loadMaterialThumbnailUrl: (token, materialId) =>
      fetchDisplayUrl(serverUrl, token, `/creation/materials/${materialId}/thumbnail-url`),
    loadMaterialPreviewUrl: (token, materialId) =>
      fetchDisplayUrl(serverUrl, token, `/creation/materials/${materialId}/preview-url`)
  }
}
