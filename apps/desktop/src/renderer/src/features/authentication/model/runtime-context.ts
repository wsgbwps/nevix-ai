import { createContext, useContext } from 'react'
import type { AuthenticationRuntime } from './use-authentication-runtime'

/**
 * The renderer-document Authentication runtime context. Only the
 * Authentication-owned provider, owned surface, and current-session reader
 * touch it; app code consumes `useCurrentSession` instead.
 */
export const AuthenticationRuntimeContext = createContext<AuthenticationRuntime | null>(null)

export function useAuthenticationRuntimeContext(): AuthenticationRuntime {
  const runtime = useContext(AuthenticationRuntimeContext)
  if (runtime === null) {
    throw new Error('The Authentication runtime must be provided by the app composition root.')
  }
  return runtime
}
