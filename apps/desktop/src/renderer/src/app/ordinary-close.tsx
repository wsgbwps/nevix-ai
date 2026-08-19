import { useCallback, useEffect, useRef } from 'react'
import {
  allowOrdinaryClose,
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

  useEffect(() => {
    const removeListener = window.api.on('window:ordinary-close-requested', (request) => {
      const handler = handlerRef.current
      if (handler) handler(request)
      // Renderer-side mirror of the main-process fail-open policy: when no handler has
      // registered (no view holds state that must decide a close), an ordinary close is allowed.
      else void allowOrdinaryClose(request.requestId)
    })
    void window.api.invoke('window:ordinary-close-ready')
    return removeListener
  }, [])

  return (
    <OrdinaryCloseHandlerContext.Provider value={registerHandler}>
      {children}
    </OrdinaryCloseHandlerContext.Provider>
  )
}
