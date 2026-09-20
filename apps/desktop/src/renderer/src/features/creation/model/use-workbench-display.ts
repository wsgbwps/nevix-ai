import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ReferenceMaterialView } from '../api/go-creation-http'
import type { ResultBlobUrlLease } from '../lib/result-blob-cache'
import {
  emptyWorkbenchDisplaySnapshot,
  WorkbenchDisplayController,
  type MaterialPreviewSource,
  type PendingMaterialFile,
  type WorkbenchDisplayDeps,
  type WorkbenchDisplaySnapshot
} from './workbench-display-controller'

/** The Workbench's handle on the display-resource module: the rendered
 * snapshot, the resource operations, and the one context-switch reset.
 * `getSnapshot` is same-tick-fresh for callbacks; method identities are stable
 * per runtime, so consumer lease effects key on them without re-running. */
export interface WorkbenchDisplayBinding {
  readonly snapshot: WorkbenchDisplaySnapshot
  readonly getSnapshot: () => WorkbenchDisplaySnapshot
  readonly reset: () => void
  readonly replaceMaterials: (views: readonly ReferenceMaterialView[]) => void
  readonly registerPending: (id: string, file: File) => ReferenceMaterialView
  readonly dropPending: (materialId: string) => void
  readonly transferPending: (localId: string, resolvedId: string) => void
  readonly updateUploadProgress: (materialId: string, sentBytes: number, totalBytes: number) => void
  readonly forget: (materialId: string) => void
  readonly requestThumbnail: (materialId: string) => void
  readonly reportThumbnailFailure: (materialId: string, source: string) => void
  readonly retain: (materialId: string) => () => void
  readonly acquireResultBlobUrl: (
    taskId: string,
    slotIndex: number
  ) => Promise<ResultBlobUrlLease | null>
  readonly loadMaterialPreviewSource: (materialId: string) => Promise<MaterialPreviewSource | null>
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
  updateUploadProgress: (): void => undefined,
  forget: (): void => undefined,
  requestThumbnail: (): void => undefined,
  reportThumbnailFailure: (): void => undefined,
  retain: (): (() => void) => () => undefined,
  acquireResultBlobUrl: (): Promise<ResultBlobUrlLease | null> => Promise.resolve(null),
  loadMaterialPreviewSource: (): Promise<MaterialPreviewSource | null> => Promise.resolve(null),
  pendingFiles: (): ReadonlyMap<string, PendingMaterialFile> => new Map()
}

/** One controller per connected runtime: an identity change replaces the
 * instance and the previous lifecycle's generation retires in the effect
 * cleanup. The constructor is passive, so memoized creation has no effects. */
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
      updateUploadProgress: (materialId: string, sentBytes: number, totalBytes: number): void =>
        controller.updateUploadProgress(materialId, sentBytes, totalBytes),
      forget: (materialId: string): void => controller.forget(materialId),
      requestThumbnail: (materialId: string): void => controller.requestThumbnail(materialId),
      reportThumbnailFailure: (materialId: string, source: string): void =>
        controller.reportThumbnailFailure(materialId, source),
      retain: (materialId: string): (() => void) => controller.retain(materialId),
      acquireResultBlobUrl: (
        taskId: string,
        slotIndex: number
      ): Promise<ResultBlobUrlLease | null> => controller.acquireResultBlobUrl(taskId, slotIndex),
      loadMaterialPreviewSource: (materialId: string): Promise<MaterialPreviewSource | null> =>
        controller.loadMaterialPreviewSource(materialId),
      pendingFiles: (): ReadonlyMap<string, PendingMaterialFile> => controller.pendingFiles()
    }
  }, [controller])

  return { snapshot, ...methods }
}
