/**
 * The creation half of the trusted data plane (contracts/creation.yaml).
 * Every call rides the current session's opaque Bearer token; the token never
 * enters a URL, and every byte of a material flows through the Go trusted
 * data plane — the renderer receives only streamed bytes and JSON views
 * (ADR-0014), never Storage credentials or direct-upload grants.
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

/**
 * Every trusted-command failure the Workbench can observe. Clients branch on
 * the contract's `error` code only; unmapped answers stay generic so an
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
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  readonly body?: unknown
  readonly token: string
}

async function request(
  serverUrl: string,
  input: RequestInput
): Promise<{ readonly outcome: 'succeeded'; readonly payload: unknown } | CreationApiFailure> {
  const url = new URL(input.path, serverUrl)
  for (const [name, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(name, value)
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

function readErrorCode(payload: unknown): string | null {
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

/**
 * Creates a typed client over one configured server URL. Paths mirror
 * contracts/creation.yaml exactly; response parsing fails closed into
 * network-failure rather than guessing shapes.
 */
export function createCreationClient(serverUrl: string): {
  listSessions(token: string, cursor?: string | null): Promise<CreationApiResult<SessionPage>>
  createSession(token: string, name?: string): Promise<CreationApiResult<CreationSessionView>>
  renameSession(
    token: string,
    sessionId: string,
    name: string
  ): Promise<CreationApiResult<CreationSessionView>>
  deleteSession(token: string, sessionId: string): Promise<CreationApiResult<void>>
  listMaterials(
    token: string,
    sessionId: string,
    cursor?: string | null
  ): Promise<CreationApiResult<MaterialPage>>
  uploadMaterial(
    token: string,
    sessionId: string,
    file: File
  ): Promise<CreationApiResult<ReferenceMaterialView>>
  deleteMaterial(token: string, materialId: string): Promise<CreationApiResult<void>>
  /**
   * Streams one owned material back through Go for thumbnail display; resolves
   * to an object URL or null when nothing renderable came back.
   */
  loadImageBlobUrl(token: string, materialId: string): Promise<string | null>
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
      return { outcome: 'request-rejected', code: 'not_found' }
    },
    listMaterials: (token, sessionId, cursor) =>
      listPage(parseMaterialPage, `/creation/sessions/${sessionId}/materials`, token, cursor),
    uploadMaterial: async (token, sessionId, file) => {
      const form = new FormData()
      form.append('file', file, file.name)
      const url = new URL(`/creation/sessions/${sessionId}/materials`, serverUrl)
      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          redirect: 'error',
          headers: { Authorization: `Bearer ${token}` },
          body: form
        })
      } catch {
        return { outcome: 'network-failure' }
      }
      if (!response.ok) {
        const failureStatus = response.status
        const code =
          failureStatus === 401
            ? 'unauthorized'
            : failureStatus === 403
              ? 'forbidden'
              : (readErrorCode(await safeJson(response)) ?? 'upload-malformed')
        if (failureStatus === 401) return { outcome: 'unauthorized' }
        if (failureStatus === 403) return { outcome: 'forbidden' }
        return { outcome: 'request-rejected', code }
      }
      const material = parseMaterial(await safeJson(response))
      return material ? { outcome: 'succeeded', value: material } : { outcome: 'network-failure' }
    },
    deleteMaterial: async (token, materialId) => {
      const url = new URL(`/creation/materials/${materialId}`, serverUrl)
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
    loadImageBlobUrl: async (token, materialId) => {
      const url = new URL(`/creation/materials/${materialId}`, serverUrl)
      let response: Response
      try {
        response = await fetch(url, {
          redirect: 'error',
          headers: { Authorization: `Bearer ${token}` }
        })
      } catch {
        return null
      }
      if (!response.ok) return null
      const blob = await response.blob().catch(() => null)
      return blob ? URL.createObjectURL(blob) : null
    }
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}
