import { createContext, useCallback, useContext, useLayoutEffect, useRef } from 'react'
import { useCreationRuntime } from './runtime-context'
import {
  type CreationSessionNavigationController,
  type CreationSessionNavigationSnapshot
} from './creation-session-navigation-controller'

export interface CreationSessionNavigation extends CreationSessionNavigationSnapshot {
  readonly reload: () => void
  readonly selectSession: CreationSessionNavigationController['selectSession']
  readonly adoptSession: CreationSessionNavigationController['adoptSession']
  readonly openPendingDraft: CreationSessionNavigationController['openPendingDraft']
  readonly startNewDraft: CreationSessionNavigationController['startNewDraft']
  readonly deleteSession: CreationSessionNavigationController['deleteSession']
  readonly renameSession: CreationSessionNavigationController['renameSession']
}

export const CreationSessionNavigationContext = createContext<CreationSessionNavigation | null>(
  null
)

export function useCreationSessionNavigation(): CreationSessionNavigation | null {
  return useContext(CreationSessionNavigationContext)
}

export function useOpenCreationSession(): ((sessionId: string) => Promise<boolean>) | undefined {
  const runtime = useCreationRuntime()
  const navigation = useCreationSessionNavigation()
  const activeRuntime = useRef(runtime)
  const readEpoch = useRef(0)
  useLayoutEffect(() => {
    activeRuntime.current = runtime
    return () => {
      activeRuntime.current = null
      readEpoch.current += 1
    }
  }, [runtime])
  const open = useCallback(
    async (sessionId: string): Promise<boolean> => {
      if (!runtime || !navigation || activeRuntime.current !== runtime) return false
      const epoch = ++readEpoch.current
      try {
        const result = await runtime.getSessionDetail(sessionId)
        if (
          activeRuntime.current !== runtime ||
          readEpoch.current !== epoch ||
          result.outcome !== 'succeeded'
        )
          return false
        navigation.adoptSession(result.value)
        return true
      } catch {
        return false
      }
    },
    [navigation, runtime]
  )
  return runtime && navigation ? open : undefined
}
