import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { CreationRuntime } from '../runtime-context'
import { emptyTaskRefreshSnapshot } from './task-refresh-controller'
import { TaskRefreshController } from './task-refresh-controller'
import type { TaskRefreshSnapshot } from './task-refresh-controller'

/** The Workbench's handle on the Generation Task refresh module (ADR-0005):
 * the current display snapshot plus the entry, stream, invalidation, and
 * business-completion inputs. Business actions reconcile through
 * requestReconcile; they never hand the module task facts to display. */
export interface TaskRefreshBinding {
  readonly snapshot: TaskRefreshSnapshot
  readonly enter: (sessionId: string) => void
  readonly leave: () => void
  readonly notifyInvalidation: () => void
  readonly setStreamLive: (live: boolean) => void
  readonly requestReconcile: () => void
}

const idleBinding: TaskRefreshBinding = {
  snapshot: emptyTaskRefreshSnapshot,
  enter: () => undefined,
  leave: () => undefined,
  notifyInvalidation: () => undefined,
  setStreamLive: () => undefined,
  requestReconcile: () => undefined
}

const noopSubscribe = (): (() => void) => () => undefined

/** One controller per connected runtime; a runtime identity change (new
 * server URL or login) replaces the instance, and the previous lifecycle's
 * timers stop in the effect cleanup. The constructor is passive, so the
 * memoized creation has no render side effects. */
export function useTaskRefreshModule(runtime: CreationRuntime): TaskRefreshBinding {
  const controller = useMemo(
    () => (runtime === null ? null : new TaskRefreshController(runtime)),
    [runtime]
  )

  useEffect(() => {
    if (controller === null) return
    // StrictMode's dev-only unmount/remount re-runs this effect on the same
    // instance, so cleanup only suspends — setup must re-arm it, exactly like
    // use-workbench's mountedRef liveness idiom.
    controller.activate()
    return () => controller.suspend()
  }, [controller])

  const subscribe = useCallback(
    (notify: () => void) => (controller === null ? noopSubscribe() : controller.subscribe(notify)),
    [controller]
  )
  const getSnapshot = useCallback(
    () => (controller === null ? emptyTaskRefreshSnapshot : controller.getSnapshot()),
    [controller]
  )
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  if (controller === null) return idleBinding
  return {
    snapshot,
    enter: (sessionId: string) => controller.enter(sessionId),
    leave: () => controller.leave(),
    notifyInvalidation: () => controller.notifyInvalidation(),
    setStreamLive: (live: boolean) => controller.setStreamLive(live),
    requestReconcile: () => controller.requestReconcile()
  }
}
