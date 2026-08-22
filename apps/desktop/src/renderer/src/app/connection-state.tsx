import { createContext, useContext } from 'react'
import type { useServerConnection } from '../features/connection'

export type ServerConnectionState = ReturnType<typeof useServerConnection>

export const ServerConnectionStateContext = createContext<ServerConnectionState | null>(null)

export function useServerConnectionState(): ServerConnectionState {
  const state = useContext(ServerConnectionStateContext)
  if (state === null) {
    throw new Error('Server connection state must be provided by the app composition root.')
  }
  return state
}
