import { expect } from '@playwright/test'

/**
 * Test-side client for the disposable identity server that scripts/run-e2e.sh builds and
 * boots for the suite. Seeding goes through the Admin API only — the same trusted data
 * plane the product uses — so specs never need database credentials.
 */

export interface IdentityServerConfig {
  readonly serverUrl: string
  readonly adminEmail: string
  readonly adminPassword: string
}

/**
 * The disposable protected empty-instance server the setup-wizard spec drives: initialized
 * by the spec itself through the wizard, using the one-time setup code parsed from that
 * server's operations log.
 */
export interface SetupServerConfig {
  readonly serverUrl: string
  readonly setupCode: string
}

/** The disposable open empty-instance server the instance-claim spec drives: no credential. */
export interface OpenServerConfig {
  readonly serverUrl: string
}

export interface TestIdentity {
  readonly email: string
  readonly password: string
}

export interface AdminUserView {
  readonly id: string
  readonly email: string
  readonly display_name: string
  readonly role: 'admin' | 'member'
  readonly status: 'active' | 'disabled'
  readonly must_change_password: boolean
}

export interface LoginGrant {
  readonly token: string
  readonly expires_at: string
  readonly user: {
    readonly id: string
    readonly email: string
    readonly display_name: string
    readonly role: 'admin' | 'member'
    readonly must_change_password: boolean
  }
}

export function readIdentityServerConfig(): IdentityServerConfig | undefined {
  const serverUrl = process.env.NEVIX_TEST_SERVER_URL
  const adminEmail = process.env.NEVIX_TEST_ADMIN_EMAIL
  const adminPassword = process.env.NEVIX_TEST_ADMIN_INITIAL_PASSWORD
  if (!serverUrl || !adminEmail || !adminPassword) return undefined
  return { serverUrl, adminEmail, adminPassword }
}

/**
 * Reads the protected empty-instance server exported by the E2E command: its URL plus the
 * one-time setup code parsed from that server's operations log. The code is only live until
 * the spec initializes the instance with it.
 */
export function readSetupServerConfig(): SetupServerConfig | undefined {
  const serverUrl = process.env.NEVIX_TEST_SETUP_SERVER_URL
  const setupCode = process.env.NEVIX_TEST_SETUP_CODE
  if (!serverUrl || !setupCode) return undefined
  return { serverUrl, setupCode }
}

/** Reads the open empty-instance server exported by the E2E command. */
export function readOpenServerConfig(): OpenServerConfig | undefined {
  const serverUrl = process.env.NEVIX_TEST_OPEN_SERVER_URL
  if (!serverUrl) return undefined
  return { serverUrl }
}

/**
 * Claims an empty instance over raw HTTP — the same public Instance Claim the wizard drives —
 * optionally with the setup code a protected deployment demands. Fails the test on anything
 * but the 201 first-admin response.
 */
export async function claimInstance(
  serverUrl: string,
  email: string,
  password: string,
  setupCode?: string,
  displayName?: string
): Promise<LoginGrant> {
  const response = await fetch(new URL('/identity/setup/initialize', serverUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      ...(setupCode !== undefined ? { setup_code: setupCode } : {}),
      ...(displayName !== undefined ? { display_name: displayName } : {})
    })
  })
  expect(response.status, await response.clone().text()).toBe(201)
  return (await response.json()) as LoginGrant
}

export function uniqueIdentity(prefix: string): TestIdentity {
  const runId = process.env.NEVIX_E2E_RUN_ID ?? `${Date.now().toString(36)}-${process.pid}`
  const randomSuffix = Math.random().toString(36).slice(2, 8)
  return {
    email: `${prefix}-${runId}-${randomSuffix}@nevix-e2e.test`,
    password: 'correct horse battery staple'
  }
}

/** Signs in over raw HTTP, outside the Desktop. Fails the test on credential errors. */
export async function loginOutsideDesktop(
  config: IdentityServerConfig,
  identity: TestIdentity
): Promise<LoginGrant> {
  const response = await fetch(new URL('/identity/auth/login', config.serverUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: identity.email, password: identity.password })
  })
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()) as LoginGrant
}

/** Asserts a session token is currently accepted (200) or rejected (401) by the server. */
export async function expectSessionAccepted(
  config: IdentityServerConfig,
  token: string,
  accepted: boolean
): Promise<void> {
  const response = await fetch(new URL('/identity/users/me', config.serverUrl), {
    headers: { Authorization: `Bearer ${token}` }
  })
  expect(response.status).toBe(accepted ? 200 : 401)
}

async function adminToken(config: IdentityServerConfig): Promise<string> {
  const grant = await loginOutsideDesktop(config, {
    email: config.adminEmail,
    password: config.adminPassword
  })
  return grant.token
}

/**
 * Creates a member account with an initial password via the Admin API. The returned user
 * has must_change_password=true, mirroring how every real member starts.
 */
export async function createTeamUser(
  config: IdentityServerConfig,
  identity: TestIdentity,
  displayName?: string
): Promise<AdminUserView> {
  const token = await adminToken(config)
  const response = await fetch(new URL('/identity/users', config.serverUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      email: identity.email,
      initial_password: identity.password,
      ...(displayName !== undefined ? { display_name: displayName } : {})
    })
  })
  expect(response.status, await response.clone().text()).toBe(201)
  const body = (await response.json()) as { user: AdminUserView }
  return body.user
}

/**
 * Creates a member account and completes the forced first-login change over raw HTTP, so
 * the returned identity signs in straight to the App Shell without the change boundary.
 */
export async function createStableTeamUser(
  config: IdentityServerConfig,
  identity: TestIdentity,
  displayName?: string
): Promise<AdminUserView> {
  const user = await createTeamUser(config, identity, displayName)
  const grant = await loginOutsideDesktop(config, identity)
  const response = await fetch(new URL('/identity/auth/change-password', config.serverUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${grant.token}`
    },
    body: JSON.stringify({
      current_password: identity.password,
      new_password: identity.password
    })
  })
  expect(response.status, await response.clone().text()).toBe(200)
  return user
}

export async function disableTeamUser(config: IdentityServerConfig, userId: string): Promise<void> {
  const token = await adminToken(config)
  const response = await fetch(new URL(`/identity/users/${userId}/disable`, config.serverUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{}'
  })
  expect(response.status, await response.clone().text()).toBe(200)
}

/**
 * Creates one active join code via the Admin API and returns its plaintext form (issue #120
 * governance surface). Codes are reusable; revocation is the only lifecycle end.
 */
export interface JoinCodeView {
  readonly id: string
  readonly code: string
  readonly label: string
  readonly created_at: string
}

export async function createJoinCode(
  config: IdentityServerConfig,
  label = ''
): Promise<JoinCodeView> {
  const token = await adminToken(config)
  const response = await fetch(new URL('/identity/admin/join-codes', config.serverUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ label })
  })
  expect(response.status, await response.clone().text()).toBe(201)
  return (await response.json()) as JoinCodeView
}

/** Revokes a join code: redemption attempts on it fail from that commit on. */
export async function revokeJoinCode(
  config: IdentityServerConfig,
  joinCodeId: string
): Promise<void> {
  const token = await adminToken(config)
  const response = await fetch(
    new URL(`/identity/admin/join-codes/${joinCodeId}`, config.serverUrl),
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    }
  )
  expect(response.status, await response.clone().text()).toBe(200)
}

/**
 * Suite-cleanup revocation for join codes. The suite shares one identity server, and
 * settings specs assert the active-code list's emptiness, so a leaked active code must
 * never be silent: 200 (revoked now) and 404 (already revoked) are success; any other
 * outcome — or a network failure — fails the test that leaked it.
 */
export async function revokeJoinCodeForCleanup(
  config: IdentityServerConfig,
  joinCodeId: string
): Promise<void> {
  const token = await adminToken(config)
  const response = await fetch(
    new URL(`/identity/admin/join-codes/${joinCodeId}`, config.serverUrl),
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    }
  )
  if (response.status !== 200 && response.status !== 404) {
    expect(response.status, await response.clone().text()).toBe(200)
  }
}

/**
 * Resets a member's password via the Admin API. The server revokes every session of that
 * user in the same write transaction, so this doubles as the out-of-band revocation path.
 */
export async function resetTeamUserPassword(
  config: IdentityServerConfig,
  userId: string,
  nextPassword: string
): Promise<void> {
  const token = await adminToken(config)
  const response = await fetch(
    new URL(`/identity/users/${userId}/reset-password`, config.serverUrl),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ initial_password: nextPassword })
    }
  )
  expect(response.status, await response.clone().text()).toBe(200)
}
