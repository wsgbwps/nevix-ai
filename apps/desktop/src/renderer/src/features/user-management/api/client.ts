/**
 * The user-management half of the trusted data plane (contracts/identity.yaml).
 * Every call rides the current session's opaque token; the token never enters a URL.
 */

/** The session half every user-management call needs: the opaque token. */
export interface AuthenticatedManagementSession {
  readonly token: string
}

export type UserRole = 'admin' | 'member'
export type UserStatus = 'active' | 'disabled'

/** The full management view only Admins may read (GET /identity/admin/users). */
export interface ManagedUser {
  readonly id: string
  readonly email: string
  readonly displayName: string
  readonly role: UserRole
  readonly status: UserStatus
  readonly mustChangePassword: boolean
  /** ISO timestamp of the last login; null means the account never logged in. */
  readonly lastLoginAt: string | null
  readonly createdAt: string
}

export interface ManagedUsersPage {
  readonly users: readonly ManagedUser[]
  readonly page: number
  readonly perPage: number
  readonly total: number
}

export interface AuditLogEntry {
  readonly id: string
  readonly action: string
  readonly actorUserId: string
  readonly actorDisplayName: string
  readonly targetUserId: string | null
  readonly targetDisplayName: string | null
  readonly metadata: Readonly<Record<string, string>>
  readonly createdAt: string
}

export interface AuditLogPage {
  readonly entries: readonly AuditLogEntry[]
  readonly page: number
  readonly perPage: number
  readonly total: number
}

/**
 * Every trusted-command failure the Desktop can observe. Clients branch on the
 * contract's `error` code only; unmapped outcomes stay generic so an unknown
 * server answer never fakes a specific governance verdict.
 */
export type ManagementApiFailure =
  | { readonly outcome: 'network-failure' }
  | { readonly outcome: 'unauthorized' }
  | { readonly outcome: 'forbidden' }
  | { readonly outcome: 'request-rejected'; readonly code: string }

export type ManagementApiResult<T> =
  | { readonly outcome: 'succeeded'; readonly value: T }
  | ManagementApiFailure

export interface ManagedUsersQuery {
  readonly page: number
  readonly perPage: number
  /** Case-insensitive substring match on email and display_name; omitted when blank. */
  readonly search?: string
}

export interface AuditLogQuery {
  readonly page: number
  readonly perPage: number
}

export interface CreateUserInput {
  readonly email: string
  readonly initialPassword: string
  /** Omitted when blank; the server then derives it from the email local part. */
  readonly displayName?: string
}

interface RequestInput {
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  readonly body?: unknown
  readonly token: string
}

async function request(
  serverUrl: string,
  input: RequestInput
): Promise<{ readonly outcome: 'succeeded'; readonly payload: unknown } | ManagementApiFailure> {
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
    // A body the Desktop cannot read as JSON is an unreachable-or-broken server,
    // not a governance verdict.
    return { outcome: 'network-failure' }
  }

  if (response.ok) return { outcome: 'succeeded', payload }

  const code = readErrorCode(payload)
  if (response.status === 401) return { outcome: 'unauthorized' }
  if (response.status === 403) return { outcome: 'forbidden' }

  return { outcome: 'request-rejected', code: code ?? 'internal_error' }
}

function commandRequest(
  session: AuthenticatedManagementSession,
  serverUrl: string,
  input: Omit<RequestInput, 'token'>
): Promise<{ readonly outcome: 'succeeded'; readonly payload: unknown } | ManagementApiFailure> {
  return request(serverUrl, { ...input, token: session.token })
}

/** A command result whose payload must parse as one updated ManagedUser, or the answer is unusable. */
async function userCommand(
  session: AuthenticatedManagementSession,
  serverUrl: string,
  input: Omit<RequestInput, 'token'>
): Promise<ManagementApiResult<ManagedUser>> {
  const result = await commandRequest(session, serverUrl, input)
  if (result.outcome !== 'succeeded') return result

  const user = parseManagedUser(readField(result.payload, 'user'))
  return user ? { outcome: 'succeeded', value: user } : { outcome: 'network-failure' }
}

export async function listManagedUsers(
  session: AuthenticatedManagementSession,
  serverUrl: string,
  query: ManagedUsersQuery
): Promise<ManagementApiResult<ManagedUsersPage>> {
  const search = query.search?.trim()
  const result = await commandRequest(session, serverUrl, {
    method: 'GET',
    path: '/identity/admin/users',
    query: {
      page: String(query.page),
      per_page: String(query.perPage),
      ...(search ? { q: search } : {})
    }
  })
  if (result.outcome !== 'succeeded') return result

  const page = parseManagedUsersPage(result.payload)
  return page ? { outcome: 'succeeded', value: page } : { outcome: 'network-failure' }
}

export async function createUser(
  session: AuthenticatedManagementSession,
  serverUrl: string,
  input: CreateUserInput
): Promise<ManagementApiResult<ManagedUser>> {
  const displayName = input.displayName?.trim()
  return userCommand(session, serverUrl, {
    method: 'POST',
    path: '/identity/users',
    body: {
      email: input.email,
      initial_password: input.initialPassword,
      ...(displayName ? { display_name: displayName } : {})
    }
  })
}

export async function disableUser(
  session: AuthenticatedManagementSession,
  serverUrl: string,
  userId: string
): Promise<ManagementApiResult<ManagedUser>> {
  return userCommand(session, serverUrl, {
    method: 'POST',
    path: `/identity/users/${encodeURIComponent(userId)}/disable`,
    body: {}
  })
}

export async function resetUserPassword(
  session: AuthenticatedManagementSession,
  serverUrl: string,
  userId: string,
  initialPassword: string
): Promise<ManagementApiResult<ManagedUser>> {
  return userCommand(session, serverUrl, {
    method: 'POST',
    path: `/identity/users/${encodeURIComponent(userId)}/reset-password`,
    body: { initial_password: initialPassword }
  })
}

export async function changeUserEmail(
  session: AuthenticatedManagementSession,
  serverUrl: string,
  userId: string,
  email: string
): Promise<ManagementApiResult<ManagedUser>> {
  return userCommand(session, serverUrl, {
    method: 'POST',
    path: `/identity/users/${encodeURIComponent(userId)}/email`,
    body: { email }
  })
}

export async function changeUserRole(
  session: AuthenticatedManagementSession,
  serverUrl: string,
  userId: string,
  role: UserRole
): Promise<ManagementApiResult<ManagedUser>> {
  return userCommand(session, serverUrl, {
    method: 'POST',
    path: `/identity/users/${encodeURIComponent(userId)}/role`,
    body: { role }
  })
}

export async function deleteUser(
  session: AuthenticatedManagementSession,
  serverUrl: string,
  userId: string
): Promise<ManagementApiResult<void>> {
  const result = await commandRequest(session, serverUrl, {
    method: 'DELETE',
    path: `/identity/users/${encodeURIComponent(userId)}`
  })
  if (result.outcome !== 'succeeded') return result
  if (readField(result.payload, 'status') !== 'deleted') return { outcome: 'network-failure' }

  return { outcome: 'succeeded', value: undefined }
}

/** One active join code the Admin card shows: the plaintext credential with its note. */
export interface JoinCode {
  readonly id: string
  readonly code: string
  readonly label: string
  readonly createdBy: string
  readonly createdAt: string
}

/** The create command's flat success body (id, code, label, created_at). */
export interface CreatedJoinCode {
  readonly id: string
  readonly code: string
  readonly label: string
  readonly createdAt: string
}

export interface CreateJoinCodeInput {
  /** Omitted when blank; the server then stores the empty string. */
  readonly label?: string
}

export async function listJoinCodes(
  session: AuthenticatedManagementSession,
  serverUrl: string
): Promise<ManagementApiResult<readonly JoinCode[]>> {
  const result = await commandRequest(session, serverUrl, {
    method: 'GET',
    path: '/identity/admin/join-codes'
  })
  if (result.outcome !== 'succeeded') return result

  const rawList = readField(result.payload, 'join_codes')
  if (!Array.isArray(rawList)) return { outcome: 'network-failure' }
  const joinCodes = rawList.map(parseJoinCode)
  return joinCodes.some((code) => code === undefined)
    ? { outcome: 'network-failure' }
    : { outcome: 'succeeded', value: joinCodes as readonly JoinCode[] }
}

export async function createJoinCode(
  session: AuthenticatedManagementSession,
  serverUrl: string,
  input: CreateJoinCodeInput
): Promise<ManagementApiResult<CreatedJoinCode>> {
  const label = input.label?.trim()
  const result = await commandRequest(session, serverUrl, {
    method: 'POST',
    path: '/identity/admin/join-codes',
    body: { ...(label ? { label } : {}) }
  })
  if (result.outcome !== 'succeeded') return result

  const id = readId(result.payload)
  const code = readRequiredString(result.payload, 'code')
  const createdLabel = readRequiredString(result.payload, 'label')
  const createdAt = readTimestamp(result.payload, 'created_at')
  if (
    id === undefined ||
    code === undefined ||
    code.length === 0 ||
    createdLabel === undefined ||
    createdAt === undefined
  ) {
    return { outcome: 'network-failure' }
  }
  return { outcome: 'succeeded', value: { id, code, label: createdLabel, createdAt } }
}

export async function revokeJoinCode(
  session: AuthenticatedManagementSession,
  serverUrl: string,
  joinCodeId: string
): Promise<ManagementApiResult<void>> {
  const result = await commandRequest(session, serverUrl, {
    method: 'DELETE',
    path: `/identity/admin/join-codes/${encodeURIComponent(joinCodeId)}`
  })
  if (result.outcome !== 'succeeded') return result
  if (readField(result.payload, 'status') !== 'revoked') return { outcome: 'network-failure' }

  return { outcome: 'succeeded', value: undefined }
}

export async function listAuditLogs(
  session: AuthenticatedManagementSession,
  serverUrl: string,
  query: AuditLogQuery
): Promise<ManagementApiResult<AuditLogPage>> {
  const result = await commandRequest(session, serverUrl, {
    method: 'GET',
    path: '/identity/audit-logs',
    query: { page: String(query.page), per_page: String(query.perPage) }
  })
  if (result.outcome !== 'succeeded') return result

  const page = parseAuditLogPage(result.payload)
  return page ? { outcome: 'succeeded', value: page } : { outcome: 'network-failure' }
}

function readField(payload: unknown, field: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined
  return (payload as Record<string, unknown>)[field]
}

function readErrorCode(payload: unknown): string | undefined {
  const code = readField(payload, 'error')
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

function readId(payload: unknown): string | undefined {
  const id = readField(payload, 'id')
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

function readRequiredString(payload: unknown, field: string): string | undefined {
  const value = readField(payload, field)
  return typeof value === 'string' ? value : undefined
}

function readTimestamp(payload: unknown, field: string): string | undefined {
  const value = readField(payload, field)
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return undefined
  return value
}

function parseManagedUser(payload: unknown): ManagedUser | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined

  const id = readId(payload)
  const email = readRequiredString(payload, 'email')
  const displayName = readRequiredString(payload, 'display_name')
  const role = readField(payload, 'role')
  const status = readField(payload, 'status')
  const mustChangePassword = readField(payload, 'must_change_password')
  const lastLoginAt = readField(payload, 'last_login_at')
  const createdAt = readTimestamp(payload, 'created_at')
  if (
    id === undefined ||
    email === undefined ||
    email.length === 0 ||
    displayName === undefined ||
    (role !== 'admin' && role !== 'member') ||
    (status !== 'active' && status !== 'disabled') ||
    typeof mustChangePassword !== 'boolean' ||
    (lastLoginAt !== null && typeof lastLoginAt !== 'string') ||
    createdAt === undefined
  ) {
    return undefined
  }

  return {
    id,
    email,
    displayName,
    role,
    status,
    mustChangePassword,
    lastLoginAt,
    createdAt
  }
}

interface PageFields {
  readonly page: number
  readonly perPage: number
  readonly total: number
}

function parseJoinCode(payload: unknown): JoinCode | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined

  const id = readId(payload)
  const code = readRequiredString(payload, 'code')
  const label = readRequiredString(payload, 'label')
  const createdBy = readRequiredString(payload, 'created_by')
  const createdAt = readTimestamp(payload, 'created_at')
  if (
    id === undefined ||
    code === undefined ||
    code.length === 0 ||
    label === undefined ||
    createdBy === undefined ||
    createdBy.length === 0 ||
    createdAt === undefined
  ) {
    return undefined
  }

  return { id, code, label, createdBy, createdAt }
}

function parsePageFields(payload: unknown): PageFields | undefined {
  const page = readField(payload, 'page')
  const perPage = readField(payload, 'per_page')
  const total = readField(payload, 'total')
  if (
    typeof page !== 'number' ||
    !Number.isInteger(page) ||
    page < 1 ||
    typeof perPage !== 'number' ||
    !Number.isInteger(perPage) ||
    perPage < 1 ||
    typeof total !== 'number' ||
    !Number.isInteger(total) ||
    total < 0
  ) {
    return undefined
  }

  return { page, perPage, total }
}

function parseManagedUsersPage(payload: unknown): ManagedUsersPage | undefined {
  const fields = parsePageFields(payload)
  if (fields === undefined) return undefined

  const usersPayload = readField(payload, 'users')
  if (!Array.isArray(usersPayload)) return undefined

  const users = usersPayload.map(parseManagedUser)
  return users.some((user) => user === undefined)
    ? undefined
    : { users: users as readonly ManagedUser[], ...fields }
}

function parseAuditLogEntry(payload: unknown): AuditLogEntry | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined

  const id = readId(payload)
  const action = readRequiredString(payload, 'action')
  const actorUserId = readRequiredString(payload, 'actor_user_id')
  if (
    id === undefined ||
    action === undefined ||
    action.length === 0 ||
    actorUserId === undefined
  ) {
    return undefined
  }
  const actorDisplayName = readRequiredString(payload, 'actor_display_name')
  if (actorDisplayName === undefined) return undefined

  const targetUserId = readField(payload, 'target_user_id')
  const targetDisplayName = readField(payload, 'target_display_name')
  if (
    (targetUserId !== null && typeof targetUserId !== 'string') ||
    (targetDisplayName !== null && typeof targetDisplayName !== 'string')
  ) {
    return undefined
  }

  const metadataPayload = readField(payload, 'metadata')
  const metadata: Record<string, string> = {}
  if (typeof metadataPayload === 'object' && metadataPayload !== null) {
    for (const [key, value] of Object.entries(metadataPayload as Record<string, unknown>)) {
      if (typeof value !== 'string') return undefined
      metadata[key] = value
    }
  } else {
    return undefined
  }

  const createdAt = readTimestamp(payload, 'created_at')
  if (createdAt === undefined) return undefined

  return {
    id,
    action,
    actorUserId,
    actorDisplayName,
    targetUserId,
    targetDisplayName,
    metadata,
    createdAt
  }
}

function parseAuditLogPage(payload: unknown): AuditLogPage | undefined {
  const fields = parsePageFields(payload)
  if (fields === undefined) return undefined

  const entriesPayload = readField(payload, 'entries')
  if (!Array.isArray(entriesPayload)) return undefined

  const entries = entriesPayload.map(parseAuditLogEntry)
  return entries.some((entry) => entry === undefined)
    ? undefined
    : { entries: entries as readonly AuditLogEntry[], ...fields }
}
