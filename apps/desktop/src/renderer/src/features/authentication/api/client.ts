import type { ServerPublicConfig } from '../../../../../shared/config/server-public-config'

/** The account half of the server's user object (contracts/identity.yaml). */
export interface UserAccount {
  readonly id: string
  readonly email: string
  readonly displayName: string
  readonly role: 'admin' | 'member'
  readonly mustChangePassword: boolean
}

/** The credentials a login hands to the Desktop; the token never enters a URL. */
export interface SessionCredentials {
  readonly token: string
  readonly expiresAt: string
  readonly user: UserAccount
}

/**
 * Every trusted-command failure the Desktop can observe. Clients branch on the
 * contract's `error` code only; unmapped outcomes stay generic so an unknown
 * server answer never fakes a specific credential verdict.
 */
export type IdentityApiFailure =
  | { readonly outcome: 'network-failure' }
  | { readonly outcome: 'unauthorized' }
  | { readonly outcome: 'rate-limited' }
  | { readonly outcome: 'request-rejected'; readonly code: string }
export type IdentityApiResult<T> =
  | { readonly outcome: 'succeeded'; readonly value: T }
  | IdentityApiFailure

export interface IdentityClient {
  readonly login: (
    email: string,
    password: string
  ) => Promise<IdentityApiResult<SessionCredentials>>
  readonly me: (token: string) => Promise<IdentityApiResult<UserAccount>>
  readonly logout: (token: string) => Promise<IdentityApiResult<void>>
  readonly changePassword: (
    token: string,
    currentPassword: string,
    newPassword: string
  ) => Promise<IdentityApiResult<void>>
}

interface RequestInput {
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly body?: unknown
  readonly token?: string
}

export function createIdentityClient(config: ServerPublicConfig): IdentityClient {
  async function request<T>(input: RequestInput): Promise<IdentityApiResult<T>> {
    let response: Response
    try {
      response = await fetch(new URL(input.path, config.url), {
        method: input.method,
        // A trusted write must never be replayed against a redirect target.
        redirect: 'error',
        headers: {
          ...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(input.token !== undefined ? { Authorization: `Bearer ${input.token}` } : {})
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
      // not a credential verdict.
      return { outcome: 'network-failure' }
    }

    if (response.ok) return { outcome: 'succeeded', value: payload as T }

    const code = readErrorCode(payload)
    // 401 `invalid_credentials` is a credential verdict (login, change-password); every other
    // 401 is the session itself being rejected, which callers treat as forced sign-out.
    if (response.status === 401 && code !== 'invalid_credentials') {
      return { outcome: 'unauthorized' }
    }
    if (response.status === 429) return { outcome: 'rate-limited' }

    return { outcome: 'request-rejected', code: code ?? 'internal_error' }
  }

  return {
    async login(email, password) {
      const result = await request<unknown>({
        method: 'POST',
        path: '/identity/auth/login',
        body: { email, password }
      })
      if (result.outcome !== 'succeeded') return result

      const credentials = toSessionCredentials(result.value)
      return credentials
        ? { outcome: 'succeeded', value: credentials }
        : { outcome: 'network-failure' }
    },

    async me(token) {
      const result = await request<unknown>({
        method: 'GET',
        path: '/identity/users/me',
        token
      })
      if (result.outcome !== 'succeeded') return result

      const user = parseUserAccount(readField(result.value, 'user'))
      return user ? { outcome: 'succeeded', value: user } : { outcome: 'network-failure' }
    },

    async logout(token) {
      return request<void>({
        method: 'POST',
        path: '/identity/auth/logout',
        body: {},
        token
      })
    },

    async changePassword(token, currentPassword, newPassword) {
      return request<void>({
        method: 'POST',
        path: '/identity/auth/change-password',
        body: { current_password: currentPassword, new_password: newPassword },
        token
      })
    }
  }
}

function readErrorCode(payload: unknown): string | undefined {
  const code = readField(payload, 'error')
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

function readField(payload: unknown, field: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined
  return (payload as Record<string, unknown>)[field]
}

function toSessionCredentials(payload: unknown): SessionCredentials | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined

  const token = readField(payload, 'token')
  const expiresAt = readField(payload, 'expires_at')
  const user = parseUserAccount(readField(payload, 'user'))
  if (typeof token !== 'string' || token.length === 0 || user === undefined) {
    return undefined
  }
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) return undefined

  return { token, expiresAt, user }
}

export function parseUserAccount(payload: unknown): UserAccount | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined

  const id = readField(payload, 'id')
  const email = readField(payload, 'email')
  const displayName = readField(payload, 'display_name')
  const role = readField(payload, 'role')
  const mustChangePassword = readField(payload, 'must_change_password')
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof email !== 'string' ||
    email.length === 0 ||
    typeof displayName !== 'string' ||
    (role !== 'admin' && role !== 'member') ||
    typeof mustChangePassword !== 'boolean'
  ) {
    return undefined
  }

  return { id, email, displayName, role, mustChangePassword }
}
