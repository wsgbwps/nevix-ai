import { useCallback, useEffect, useRef } from 'react'
import {
  decideOrdinaryClose,
  OrdinaryCloseHandlerContext,
  type OrdinaryCloseHandler
} from './ordinary-close-handler'

export function OrdinaryCloseProvider({
  children
}: {
  readonly children: React.ReactNode
}): React.JSX.Element {
  const handlerRef = useRef<OrdinaryCloseHandler | undefined>(undefined)
  const registerHandler = useCallback((handler: OrdinaryCloseHandler | undefined): void => {
    handlerRef.current = handler
  }, [])

  useEffect(
    () =>
      window.api.on('window:ordinary-close-requested', (request) => {
        const handler = handlerRef.current
        if (handler) handler(request)
        else void decideOrdinaryClose(request.requestId, 'allow')
      }),
    []
  )

  return (
    <OrdinaryCloseHandlerContext.Provider value={registerHandler}>
      {children}
    </OrdinaryCloseHandlerContext.Provider>
  )
}
