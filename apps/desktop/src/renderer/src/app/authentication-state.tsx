import { createContext, useContext } from 'react'
import type { useAuthentication } from '../features/authentication'

export type AuthenticationState = ReturnType<typeof useAuthentication>

export const AuthenticationStateContext = createContext<AuthenticationState | null>(null)

export function useAuthenticationState(): AuthenticationState {
  const state = useContext(AuthenticationStateContext)
  if (state === null) {
    throw new Error('Authentication state must be provided by the app composition root.')
  }
  return state
}
