import { createContext, useContext, useEffect } from 'react'
import type { OrdinaryCloseRequestedEvent } from '../../../shared/ipc/window/types'

export type OrdinaryCloseHandler = (request: OrdinaryCloseRequestedEvent) => void

export const OrdinaryCloseHandlerContext = createContext<
  ((handler: OrdinaryCloseHandler | undefined) => void) | undefined
>(undefined)

export async function decideOrdinaryClose(
  requestId: string,
  decision: 'allow' | 'cancel'
): Promise<void> {
  await window.api.invoke('window:decide-ordinary-close', { requestId, decision })
}

export function useOrdinaryCloseHandler(handler: OrdinaryCloseHandler): void {
  const registerHandler = useContext(OrdinaryCloseHandlerContext)
  if (!registerHandler) {
    throw new Error('Ordinary close handling must be provided by the app composition root.')
  }

  useEffect(() => {
    registerHandler(handler)
    return () => registerHandler(undefined)
  }, [handler, registerHandler])
}

export async function allowOrdinaryClose(requestId: string): Promise<void> {
  await decideOrdinaryClose(requestId, 'allow')
}

export async function cancelOrdinaryClose(requestId: string): Promise<void> {
  await decideOrdinaryClose(requestId, 'cancel')
}
