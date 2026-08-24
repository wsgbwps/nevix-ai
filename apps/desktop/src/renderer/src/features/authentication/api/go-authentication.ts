/**
 * The Go Authentication seam, expressed in Authentication Domain semantics.
 *
 * The port is internal to the Authentication Feature: production supplies the
 * HTTP adapter over the identity API, and Authentication-owned test
 * composition supplies an in-memory adapter. The implementation never sees
 * fetch, Response, HTTP status, or wire payloads — only the verdicts below.
 */

/** The account half of the server's user object (contracts/identity.yaml). */
export interface UserAccount {
  readonly id: string
  readonly email: string
  readonly displayName: string
  readonly role: 'admin' | 'member'
  readonly mustChangePassword: boolean
}

/** The credentials a verified authentication hands to the Desktop; the token never enters a URL. */
export interface SessionCredentials {
  readonly token: string
  readonly expiresAt: string
  readonly user: UserAccount
}

/** The server could not be asked, or answered nothing the Desktop can act on. */
export interface GoAuthenticationUnavailable {
  readonly outcome: 'unavailable'
}

/** The server demands slower submissions; retrying is a user decision, never automatic. */
export interface GoAuthenticationRateLimited {
  readonly outcome: 'rate-limited'
}

/** The public setup probe: whether the instance still awaits its first administrator. */
export type SetupProbeResult =
  | {
      readonly outcome: 'succeeded'
      readonly initialized: boolean
      readonly setupCodeRequired: boolean
    }
  | GoAuthenticationUnavailable

/** Claiming the empty instance as its first administrator. */
export type InstanceClaimResult =
  | { readonly outcome: 'succeeded'; readonly session: SessionCredentials }
  /** The protected deployment's setup code was wrong; the claim form stays usable. */
  | { readonly outcome: 'invalid-setup-code' }
  /** Another request won the first-admin race; the claim surface is over for this device. */
  | { readonly outcome: 'already-claimed' }
  /** The chosen password is below the server's minimum length. */
  | { readonly outcome: 'new-password-too-short' }
  /** The chosen password exceeds the server's byte limit. */
  | { readonly outcome: 'new-password-over-limit' }
  | GoAuthenticationRateLimited
  | GoAuthenticationUnavailable

/** Signing in with email and password. */
export type SignInResult =
  | { readonly outcome: 'succeeded'; readonly session: SessionCredentials }
  /** Email or password was wrong; the safe credential verdict that never enumerates accounts. */
  | { readonly outcome: 'invalid-credentials' }
  | { readonly outcome: 'account-disabled' }
  | GoAuthenticationRateLimited
  | GoAuthenticationUnavailable

/** Self-registering with a Join Code. */
export type RegistrationResult =
  | { readonly outcome: 'succeeded'; readonly session: SessionCredentials }
  | { readonly outcome: 'invalid-join-code' }
  | { readonly outcome: 'email-taken' }
  /** The chosen password is below the server's minimum length. */
  | { readonly outcome: 'new-password-too-short' }
  /** The chosen password exceeds the server's byte limit. */
  | { readonly outcome: 'new-password-over-limit' }
  | GoAuthenticationRateLimited
  | GoAuthenticationUnavailable

/** Revalidating a stored session against the server before any shell opens. */
export type SessionValidationResult =
  | { readonly outcome: 'succeeded'; readonly user: UserAccount }
  /** The session itself was rejected; local credentials must die, never retry. */
  | { readonly outcome: 'session-rejected' }
  | GoAuthenticationUnavailable

/** Completing the forced password change on the current session. */
export type PasswordChangeResult =
  | { readonly outcome: 'succeeded' }
  /** The current password was wrong. */
  | { readonly outcome: 'invalid-current-password' }
  /** The server rejected the new password's length. */
  | { readonly outcome: 'new-password-rejected' }
  | { readonly outcome: 'session-rejected' }
  | GoAuthenticationRateLimited
  | GoAuthenticationUnavailable

/**
 * Ending the current session on the server. `unconfirmed` means revocation
 * could not be confirmed; local access still ends — the caller shows the
 * delayed-revocation notice instead of keeping the session alive.
 */
export type SessionEndResult = { readonly outcome: 'revoked' } | { readonly outcome: 'unconfirmed' }

export interface GoAuthentication {
  readonly probeSetup: () => Promise<SetupProbeResult>
  readonly claimInstance: (
    email: string,
    password: string,
    setupCode: string | undefined,
    displayName: string | undefined
  ) => Promise<InstanceClaimResult>
  readonly signIn: (email: string, password: string) => Promise<SignInResult>
  readonly register: (
    email: string,
    password: string,
    joinCode: string,
    displayName: string | undefined
  ) => Promise<RegistrationResult>
  readonly validateSession: (token: string) => Promise<SessionValidationResult>
  readonly changePassword: (
    token: string,
    currentPassword: string,
    newPassword: string
  ) => Promise<PasswordChangeResult>
  readonly endSession: (token: string) => Promise<SessionEndResult>
}
