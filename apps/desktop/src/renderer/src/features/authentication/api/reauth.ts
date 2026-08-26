import type { IdentityApiFailure, IdentityApiResult } from './client'

/**
 * The closed exact-action set the server declares for Reauthentication
 * Proofs (issue #154). Callers can only request one of these actions; no
 * other high-risk action is pre-built, so the client refuses to send
 * anything outside the set before any network work happens.
 */
export const REAUTH_ACTIONS = [
  'provider_connection.create',
  'provider_connection.replace',
  'provider_connection.delete'
] as const

export type ReauthAction = (typeof REAUTH_ACTIONS)[number]

export function isReauthAction(value: string): value is ReauthAction {
  return (REAUTH_ACTIONS as readonly string[]).includes(value)
}

/** One issued proof: the opaque token body, its bound action, and the server-computed expiry. */
export interface IssuedReauthProof {
  readonly proof: string
  readonly action: ReauthAction
  readonly expiresAt: string
}

export type ReauthIssueResult = IdentityApiResult<IssuedReauthProof>

/**
 * The proof-issuance seam consumed by the reusable confirmation surface.
 * Production uses {@link createReauthProofRequester}; component tests inject
 * a scripted requester through the same interface.
 */
export interface ReauthProofRequester {
  readonly issue: (
    token: string,
    action: ReauthAction,
    password: string
  ) => Promise<ReauthIssueResult>
}

export function createReauthProofRequester(serverUrl: string): ReauthProofRequester {
  return {
    async issue(token, action, password) {
      // The closed set is enforced client-side too: an undeclared action
      // never reaches the network (issue #154's "callers may only request a
      // declared exact action").
      if (!isReauthAction(action)) {
        return { outcome: 'request-rejected', code: 'invalid_action' }
      }
      let response: Response
      try {
        response = await fetch(new URL('/identity/admin/reauth/proofs', serverUrl), {
          method: 'POST',
          // A trusted write must never be replayed against a redirect target.
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ action, password })
        })
      } catch {
        return { outcome: 'network-failure' }
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        // A body the Desktop cannot read as JSON is an unreachable-or-broken
        // server, not a credential verdict.
        return { outcome: 'network-failure' }
      }

      if (response.ok) {
        const proof = parseIssuedProof(payload, action)
        return proof ? { outcome: 'succeeded', value: proof } : { outcome: 'network-failure' }
      }

      const code = readErrorCode(payload)
      // 401 invalid_credentials is a credential verdict; every other 401 is
      // the session itself being rejected — the same split the identity
      // client applies.
      if (response.status === 401 && code !== 'invalid_credentials') {
        return { outcome: 'unauthorized' }
      }
      if (response.status === 429) return { outcome: 'rate-limited' }

      return { outcome: 'request-rejected', code: code ?? 'internal_error' }
    }
  }
}

function readErrorCode(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const code = (payload as Record<string, unknown>)['error']
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

function parseIssuedProof(payload: unknown, action: ReauthAction): IssuedReauthProof | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const proof = (payload as Record<string, unknown>)['proof']
  const expiresAt = (payload as Record<string, unknown>)['expires_at']
  if (typeof proof !== 'string' || proof.length === 0) return undefined
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) return undefined
  return { proof, action, expiresAt }
}

export type { IdentityApiFailure }
