import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { createCreationWorkspacePorts, type TokenSource } from './ports'
import { CreationRuntimeContext, type CreationRuntime } from './runtime-context'
import { createCreationRuntime } from './workbench-runtime'

/**
 * Owns one Creation runtime for the current authenticated server use period.
 * Route changes cannot retire it; changing or losing that identity does.
 */
export function CreationRuntimeProvider({
  acquireSession,
  serverUrl,
  userId,
  children
}: {
  readonly acquireSession: TokenSource | undefined
  readonly serverUrl: string | undefined
  readonly userId: string | undefined
  readonly children: ReactNode
}): React.JSX.Element {
  const runtime = useMemo(
    () =>
      acquireSession !== undefined && userId !== undefined && serverUrl !== undefined
        ? createCreationRuntime(createCreationWorkspacePorts(serverUrl, acquireSession), userId)
        : null,
    [acquireSession, serverUrl, userId]
  )

  useRuntimeRetirementLease(runtime)

  return (
    <CreationRuntimeContext.Provider value={runtime}>{children}</CreationRuntimeContext.Provider>
  )
}

function useRuntimeRetirementLease(runtime: CreationRuntime): void {
  const activeLeaseRef = useRef<{ readonly runtime: CreationRuntime } | null>(null)

  useLayoutEffect(() => {
    const lease = { runtime }
    activeLeaseRef.current = lease
    return () => {
      // StrictMode immediately reacquires the same runtime after its effect
      // replay. A real unmount or identity change has no matching lease.
      queueMicrotask(() => {
        const activeLease = activeLeaseRef.current
        if (activeLease !== lease && activeLease?.runtime === runtime) return
        runtime?.retire()
        if (activeLeaseRef.current === lease) activeLeaseRef.current = null
      })
    }
  }, [runtime])
}
