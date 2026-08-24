/**
 * The production Go Authentication adapter: the identity HTTP transport
 * wrapped in the port's Authentication-semantic verdicts. URL construction,
 * methods, redirect policy, Bearer placement, payload parsing, and error
 * classification stay in `client.ts`; this adapter only translates transport
 * outcomes into Domain verdicts so the implementation never sees them.
 */
import { createIdentityClient, type IdentityClient, type IdentityApiFailure } from './client'
import type {
  GoAuthentication,
  InstanceClaimResult,
  PasswordChangeResult,
  RegistrationResult,
  SessionEndResult,
  SessionValidationResult,
  SetupProbeResult,
  SignInResult
} from './go-authentication'

export function createGoAuthenticationOverHttp(serverUrl: string): GoAuthentication {
  const client: IdentityClient = createIdentityClient(serverUrl)

  return {
    async probeSetup(): Promise<SetupProbeResult> {
      const probe = await client.setupStatus()
      if (probe.outcome !== 'succeeded') return { outcome: 'unavailable' }
      return {
        outcome: 'succeeded',
        initialized: probe.value.initialized,
        setupCodeRequired: probe.value.setupCodeRequired
      }
    },

    async claimInstance(email, password, setupCode, displayName): Promise<InstanceClaimResult> {
      const claim = await client.initialize(email, password, setupCode, displayName)
      if (claim.outcome === 'succeeded') {
        return { outcome: 'succeeded', session: claim.value }
      }
      if (claim.outcome === 'request-rejected') {
        if (claim.code === 'instance_already_initialized') return { outcome: 'already-claimed' }
        if (claim.code === 'invalid_setup_code') return { outcome: 'invalid-setup-code' }
        if (claim.code === 'password_too_short') return { outcome: 'new-password-too-short' }
        if (claim.code === 'invalid_password') return { outcome: 'new-password-over-limit' }
      }
      return mapCommonFailure(claim)
    },

    async signIn(email, password): Promise<SignInResult> {
      const login = await client.login(email, password)
      if (login.outcome === 'succeeded') return { outcome: 'succeeded', session: login.value }
      if (login.outcome === 'request-rejected') {
        if (login.code === 'invalid_credentials') return { outcome: 'invalid-credentials' }
        if (login.code === 'account_disabled') return { outcome: 'account-disabled' }
      }
      return mapCommonFailure(login)
    },

    async register(email, password, joinCode, displayName): Promise<RegistrationResult> {
      const registration = await client.register(email, password, joinCode, displayName)
      if (registration.outcome === 'succeeded') {
        return { outcome: 'succeeded', session: registration.value }
      }
      if (registration.outcome === 'request-rejected') {
        if (registration.code === 'invalid_join_code') return { outcome: 'invalid-join-code' }
        if (registration.code === 'email_taken') return { outcome: 'email-taken' }
        if (registration.code === 'password_too_short') return { outcome: 'new-password-too-short' }
        if (registration.code === 'invalid_password') return { outcome: 'new-password-over-limit' }
      }
      return mapCommonFailure(registration)
    },

    async validateSession(token): Promise<SessionValidationResult> {
      const validation = await client.me(token)
      if (validation.outcome === 'succeeded') {
        return { outcome: 'succeeded', user: validation.value }
      }
      // A 401 that is not a credential verdict is the session itself being rejected.
      if (validation.outcome === 'unauthorized') return { outcome: 'session-rejected' }
      return { outcome: 'unavailable' }
    },

    async changePassword(token, currentPassword, newPassword): Promise<PasswordChangeResult> {
      const change = await client.changePassword(token, currentPassword, newPassword)
      if (change.outcome === 'succeeded') return { outcome: 'succeeded' }
      if (change.outcome === 'unauthorized') return { outcome: 'session-rejected' }
      if (change.outcome === 'request-rejected') {
        // A wrong current password keeps the anti-enumeration credential code; the
        // server answers both new-password length failures with one code.
        if (change.code === 'invalid_credentials') return { outcome: 'invalid-current-password' }
        if (change.code === 'invalid_password') return { outcome: 'new-password-rejected' }
      }
      return mapCommonFailure(change)
    },

    async endSession(token): Promise<SessionEndResult> {
      const end = await client.logout(token)
      // Anything but a confirmed revocation leaves the delayed-revocation verdict;
      // local access ends either way, so no finer failure identity is needed.
      return end.outcome === 'succeeded' ? { outcome: 'revoked' } : { outcome: 'unconfirmed' }
    }
  }
}

/**
 * The verdicts every operation shares: rate limiting keeps its identity for
 * the caller to respect, and everything else — including verdicts the Desktop
 * does not map — stays an unreachable-or-broken server, never a fake
 * credential verdict.
 */
function mapCommonFailure(
  failure: IdentityApiFailure
): { readonly outcome: 'rate-limited' } | { readonly outcome: 'unavailable' } {
  if (failure.outcome === 'rate-limited') return { outcome: 'rate-limited' }
  return { outcome: 'unavailable' }
}
