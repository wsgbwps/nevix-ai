import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  emptyWorkbenchContextSnapshot,
  WorkbenchContextController,
  type WorkbenchContextDeps,
  type WorkbenchContextSnapshot
} from './workbench-context-controller'

/** The Workbench's handle on the Workbench Context module: the rendered
 * snapshot plus the controller itself, whose method identities are stable
 * for the connected runtime's lifetime. `getSnapshot` on the controller is
 * the same-tick-fresh read for orchestration callbacks; the binding's
 * snapshot is the committed one. Undefined controller means no runtime. */
export interface WorkbenchContextBinding {
  readonly snapshot: WorkbenchContextSnapshot
  readonly controller: WorkbenchContextController | undefined
}

const idleContextBinding: WorkbenchContextBinding = {
  snapshot: emptyWorkbenchContextSnapshot,
  controller: undefined
}

const noopSubscribe = (): (() => void) => () => undefined

/** One controller per connected runtime; a runtime identity change replaces
 * the instance and the previous lifecycle's in-flight reads retire in the
 * effect cleanup. The constructor is passive, so the memoized creation has
 * no render side effects. */
export function useWorkbenchContext(deps: WorkbenchContextDeps | null): WorkbenchContextBinding {
  const controller = useMemo(
    () => (deps === null ? undefined : new WorkbenchContextController(deps)),
    [deps]
  )

  useEffect(() => {
    if (controller === undefined) return
    controller.activate()
    return () => controller.suspend()
  }, [controller])

  const subscribe = useCallback(
    (notify: () => void) =>
      controller === undefined ? noopSubscribe() : controller.subscribe(notify),
    [controller]
  )
  const getSnapshot = useCallback(
    () => (controller === undefined ? emptyWorkbenchContextSnapshot : controller.getSnapshot()),
    [controller]
  )
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  if (controller === undefined) return idleContextBinding
  return { snapshot, controller }
}
