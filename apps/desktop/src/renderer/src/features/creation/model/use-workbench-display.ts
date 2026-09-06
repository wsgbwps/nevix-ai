import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ReferenceMaterialView } from '../api/go-creation-http'
import type { ResultBlobUrlLease } from '../lib/result-blob-cache'
import {
  emptyWorkbenchDisplaySnapshot,
  WorkbenchDisplayController,
  type PendingMaterialFile,
  type WorkbenchDisplayDeps,
  type WorkbenchDisplaySnapshot
} from './workbench-display-controller'

/** The Workbench's handle on the display-resource module: the rendered
 * snapshot plus the resource operations and the one context-switch reset.
 * `getSnapshot` is the same-tick-fresh read for orchestration callbacks. */
export interface WorkbenchDisplayBinding {
  readonly snapshot: WorkbenchDisplaySnapshot
  readonly getSnapshot: () => WorkbenchDisplaySnapshot
  readonly reset: () => void
  readonly replaceMaterials: (views: readonly ReferenceMaterialView[]) => void
  readonly registerPending: (id: string, file: File) => ReferenceMaterialView
  readonly dropPending: (materialId: string) => void
  readonly forget: (materialId: string) => void
  readonly requestThumbnail: (materialId: string) => void
  readonly retain: (materialId: string) => () => void
  readonly acquireResultBlobUrl: (
    taskId: string,
    slotIndex: number
  ) => Promise<ResultBlobUrlLease | null>
  readonly resultBlob: (taskId: string, slotIndex: number) => Promise<Blob | null>
  readonly loadMaterialPreviewBlob: (
    materialId: string,
    signal?: AbortSignal
  ) => Promise<Blob | null>
  readonly pendingFiles: () => ReadonlyMap<string, PendingMaterialFile>
  readonly hasPending: (materialId: string) => boolean
}

const noopSubscribe = (): (() => void) => () => undefined

const idleDisplayBinding: WorkbenchDisplayBinding = {
  snapshot: emptyWorkbenchDisplaySnapshot,
  getSnapshot: () => emptyWorkbenchDisplaySnapshot,
  reset: () => undefined,
  replaceMaterials: () => undefined,
  registerPending: (): ReferenceMaterialView => {
    throw new Error('workbench display module is inactive')
  },
  dropPending: () => undefined,
  forget: () => undefined,
  requestThumbnail: () => undefined,
  retain: () => () => undefined,
  acquireResultBlobUrl: () => Promise.resolve(null),
  resultBlob: () => Promise.resolve(null),
  loadMaterialPreviewBlob: () => Promise.resolve(null),
  pendingFiles: () => new Map(),
  hasPending: () => false
}

/** One controller per connected runtime; a runtime identity change replaces
 * the instance and the previous lifecycle's generation is retired in the
 * effect cleanup. The constructor is passive, so the memoized creation has
 * no render side effects. */
export function useWorkbenchDisplay(deps: WorkbenchDisplayDeps | null): WorkbenchDisplayBinding {
  const controller = useMemo(
    () => (deps === null ? null : new WorkbenchDisplayController(deps)),
    [deps]
  )

  useEffect(() => {
    if (controller === null) return
    controller.activate()
    return () => controller.dispose()
  }, [controller])

  const subscribe = useCallback(
    (notify: () => void) => (controller === null ? noopSubscribe() : controller.subscribe(notify)),
    [controller]
  )
  const getSnapshot = useCallback(
    () => (controller === null ? emptyWorkbenchDisplaySnapshot : controller.getSnapshot()),
    [controller]
  )
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  if (controller === null) return idleDisplayBinding
  return {
    snapshot,
    getSnapshot: () => controller.getSnapshot(),
    reset: () => controller.reset(),
    replaceMaterials: (views) => controller.replaceMaterials(views),
    registerPending: (id, file) => controller.registerPending(id, file),
    dropPending: (materialId) => controller.dropPending(materialId),
    forget: (materialId) => controller.forget(materialId),
    requestThumbnail: (materialId) => controller.requestThumbnail(materialId),
    retain: (materialId) => controller.retain(materialId),
    acquireResultBlobUrl: (taskId, slotIndex) => controller.acquireResultBlobUrl(taskId, slotIndex),
    resultBlob: (taskId, slotIndex) => controller.resultBlob(taskId, slotIndex),
    loadMaterialPreviewBlob: (materialId, signal) =>
      controller.loadMaterialPreviewBlob(materialId, signal),
    pendingFiles: () => controller.pendingFiles(),
    hasPending: (materialId) => controller.hasPending(materialId)
  }
}
