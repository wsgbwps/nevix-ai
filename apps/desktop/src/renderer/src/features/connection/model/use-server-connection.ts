import { useCallback, useEffect, useRef, useState } from 'react'
import { readServerConnection } from '../api/client'

export type ServerConnectionStatus = 'restoring' | 'unconfigured' | 'configured'

export interface ServerConnection {
  readonly status: ServerConnectionStatus
  readonly url: string | undefined
}

/**
 * The device's runtime server connection (ADR-0014): read once per document
 * load through the trusted IPC store; every mutation goes through the
 * Connection Screen or the Settings section and ends in a document reload.
 */
export function useServerConnection(): ServerConnection {
  const [status, setStatus] = useState<ServerConnectionStatus>('restoring')
  const [url, setUrl] = useState<string>()
  const hasInitializedRef = useRef(false)

  const restore = useCallback(async (): Promise<void> => {
    try {
      const connection = await readServerConnection()
      if (connection.state === 'configured') {
        setUrl(connection.url)
        setStatus('configured')
      } else {
        setUrl(undefined)
        setStatus('unconfigured')
      }
    } catch {
      setUrl(undefined)
      setStatus('unconfigured')
    }
  }, [])

  useEffect(() => {
    if (hasInitializedRef.current) return
    hasInitializedRef.current = true
    void restore()
  }, [restore])

  return { status, url }
}
