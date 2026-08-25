import type { UserAccount } from '../api/go-authentication'
import { useAuthenticationRuntimeContext } from './runtime-context'

/**
 * The complete user summary a current session exposes: the last
 * server-validated snapshot, for display and visibility only. Display names
 * belong to the Profile Domain, so no partial or richer user shape exists
 * here.
 */
export interface SessionUserSummary {
  readonly id: string
  readonly email: string
  readonly role: UserAccount['role']
}

/** The credential an operation needs right now; never cached across operations. */
export interface SessionAcquisition {
  readonly token: string
}

/**
 * The only current-session view app code may consume. Every
 * pre-authentication state — restore, unauthenticated, Instance Claim,
 * registration, and forced password change — collapses to `unavailable`;
 * partial user facts are not representable.
 */
export type CurrentSession =
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'available'
      readonly user: SessionUserSummary
      /** Reads the live runtime at each invocation; answers unavailable once the session has ended. */
      readonly acquireSession: () => Promise<SessionAcquisition | undefined>
      /** Single-flight current-device sign-out; completion means local access has ended. */
      readonly signOut: () => Promise<void>
      readonly isSigningOut: boolean
    }

const UNAVAILABLE_SESSION: CurrentSession = { status: 'unavailable' }

export function useCurrentSession(): CurrentSession {
  const runtime = useAuthenticationRuntimeContext()
  if (runtime.status !== 'authenticated' || runtime.sessionUser === undefined) {
    return UNAVAILABLE_SESSION
  }

  return {
    status: 'available',
    user: {
      id: runtime.sessionUser.id,
      email: runtime.sessionUser.email,
      role: runtime.sessionUser.role
    },
    acquireSession: runtime.acquireSession,
    signOut: runtime.signOut,
    isSigningOut: runtime.isSigningOut
  }
}
