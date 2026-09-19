import { useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { readLocalDraft } from './draft-store'
import {
  CreationSessionNavigationContext,
  type CreationSessionNavigation
} from './creation-session-navigation-context'
import {
  CreationSessionNavigationController,
  emptyCreationSessionNavigationSnapshot,
  type CreationSessionNavigationDeps,
  type PendingDraftEntry
} from './creation-session-navigation-controller'
import { useCreationRuntime } from './runtime-context'

const noopSubscribe = (): (() => void) => () => undefined

function pendingDrafts(
  runtime: NonNullable<ReturnType<typeof useCreationRuntime>>
): readonly PendingDraftEntry[] {
  const storage =
    typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage
  return runtime.actions.pendingDrafts().map((key) => {
    const stored = storage === undefined ? null : readLocalDraft(storage, runtime.userId, key)
    return {
      key,
      title: (stored?.prompt ?? '').trim().split('\n')[0],
      status: runtime.actions.snapshot(key).status
    }
  })
}

export function CreationSessionNavigationProvider({
  children
}: {
  readonly children: ReactNode
}): React.JSX.Element {
  const runtime = useCreationRuntime()
  const deps = useMemo<CreationSessionNavigationDeps | null>(() => {
    if (runtime === null) return null
    return {
      listSessions: () => runtime.listSessions(),
      renameSession: (sessionId, name) => runtime.renameSession(sessionId, name),
      deleteSession: (sessionId) => runtime.actions.deleteSession(sessionId),
      pendingDrafts: () => pendingDrafts(runtime)
    }
  }, [runtime])
  const controller = useMemo(
    () => (deps === null ? undefined : new CreationSessionNavigationController(deps)),
    [deps]
  )

  useEffect(() => {
    if (controller === undefined) return
    controller.activate()
    return () => controller.suspend()
  }, [controller])

  useEffect(() => {
    if (runtime === null || controller === undefined) return
    return runtime.actions.subscribe((event) => {
      if (event.type === 'sessions-reconcile') {
        controller.reload()
      } else if (event.type === 'materialized') {
        controller.noteSessionMaterialized(event.session, event.pendingKey)
      } else {
        controller.refreshPendingDrafts()
      }
    })
  }, [controller, runtime])

  const subscribe = useCallback(
    (notify: () => void) =>
      controller === undefined ? noopSubscribe() : controller.subscribe(notify),
    [controller]
  )
  const getSnapshot = useCallback(
    () =>
      controller === undefined ? emptyCreationSessionNavigationSnapshot : controller.getSnapshot(),
    [controller]
  )
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const value = useMemo<CreationSessionNavigation | null>(() => {
    if (controller === undefined) return null
    return {
      ...snapshot,
      reload: () => controller.reload(),
      selectSession: (session) => controller.selectSession(session),
      adoptSession: (session) => controller.adoptSession(session),
      openPendingDraft: (key) => controller.openPendingDraft(key),
      startNewDraft: () => controller.startNewDraft(),
      deleteSession: (sessionId) => controller.deleteSession(sessionId),
      renameSession: (sessionId, name) => controller.renameSession(sessionId, name)
    }
  }, [controller, snapshot])

  return (
    <CreationSessionNavigationContext.Provider value={value}>
      {children}
    </CreationSessionNavigationContext.Provider>
  )
}
