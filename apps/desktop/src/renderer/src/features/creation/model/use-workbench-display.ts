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
 * `getSnapshot` is the same-tick-fresh read for orchestration callbacks.
 * Method identities are stable per runtime: consumer lease effects key on
 * them and must not re-run per render. */
export interface WorkbenchDisplayBinding {
  readonly snapshot: WorkbenchDisplaySnapshot
  readonly getSnapshot: () => WorkbenchDisplaySnapshot
  readonly reset: () => void
  readonly replaceMaterials: (views: readonly ReferenceMaterialView[]) => void
  readonly registerPending: (id: string, file: File) => ReferenceMaterialView
  readonly dropPending: (materialId: string) => void
  readonly transferPending: (localId: string, resolvedId: string) => void
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
}

const noopSubscribe = (): (() => void) => () => undefined

const idleDisplayMethods = {
  getSnapshot: (): WorkbenchDisplaySnapshot => emptyWorkbenchDisplaySnapshot,
  reset: (): void => undefined,
  replaceMaterials: (): void => undefined,
  registerPending: (): ReferenceMaterialView => {
    throw new Error('workbench display module is inactive')
  },
  dropPending: (): void => undefined,
  transferPending: (): void => undefined,
  forget: (): void => undefined,
  requestThumbnail: (): void => undefined,
  retain: (): (() => void) => () => undefined,
  acquireResultBlobUrl: (): Promise<ResultBlobUrlLease | null> => Promise.resolve(null),
  resultBlob: (): Promise<Blob | null> => Promise.resolve(null),
  loadMaterialPreviewBlob: (): Promise<Blob | null> => Promise.resolve(null),
  pendingFiles: (): ReadonlyMap<string, PendingMaterialFile> => new Map()
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

  // One methods object per controller, so every member's identity survives
  // re-renders (the returned binding itself is per-render, like
  // TaskRefreshBinding).
  const methods = useMemo(() => {
    if (controller === null) return idleDisplayMethods
    return {
      getSnapshot: (): WorkbenchDisplaySnapshot => controller.getSnapshot(),
      reset: (): void => controller.reset(),
      replaceMaterials: (views: readonly ReferenceMaterialView[]): void =>
        controller.replaceMaterials(views),
      registerPending: (id: string, file: File): ReferenceMaterialView =>
        controller.registerPending(id, file),
      dropPending: (materialId: string): void => controller.dropPending(materialId),
      transferPending: (localId: string, resolvedId: string): void =>
        controller.transferPending(localId, resolvedId),
      forget: (materialId: string): void => controller.forget(materialId),
      requestThumbnail: (materialId: string): void => controller.requestThumbnail(materialId),
      retain: (materialId: string): (() => void) => controller.retain(materialId),
      acquireResultBlobUrl: (
        taskId: string,
        slotIndex: number
      ): Promise<ResultBlobUrlLease | null> => controller.acquireResultBlobUrl(taskId, slotIndex),
      resultBlob: (taskId: string, slotIndex: number): Promise<Blob | null> =>
        controller.resultBlob(taskId, slotIndex),
      loadMaterialPreviewBlob: (materialId: string, signal?: AbortSignal): Promise<Blob | null> =>
        controller.loadMaterialPreviewBlob(materialId, signal),
      pendingFiles: (): ReadonlyMap<string, PendingMaterialFile> => controller.pendingFiles()
    }
  }, [controller])

  return { snapshot, ...methods }
}
