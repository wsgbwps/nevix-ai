/**
 * The Workbench display-resource module: it owns the displayed context's
 * Reference Material views, their thumbnails and object URLs, the
 * device-local pending material files, and the verified result blob leases
 * (ADR-0018). A single `reset()` retires one display generation — the one
 * context-switch ritual every surface change goes through, keeping the
 * `pending:<uuid>` / `new` / session ownership semantics of ADR-0017.
 *
 * Framework-free (the task-refresh module's pattern, ADR-0005) so the switch
 * invariants — leases die with their generation, in-flight loads cannot land
 * after reset, getSnapshot stays fresh within the same tick — are testable
 * against scripted deps.
 */
import type { CreationApiResult, ReferenceMaterialView } from '../api/go-creation-http'
import { loadImageDimensions } from '../lib/image-dimensions'
import { MaterialUrlOwner } from '../lib/material-url-owner'
import { ResultBlobCache, type ResultBlobUrlLease } from '../lib/result-blob-cache'

export type MaterialThumbnailState = 'loading' | 'failed' | 'ready'

/** The read seam this module consumes; no business commands cross it. */
export interface WorkbenchDisplayDeps {
  readonly loadMaterialBlob: (
    materialId: string,
    signal?: AbortSignal
  ) => Promise<CreationApiResult<Blob>>
  readonly loadResultBlob: (taskId: string, slotIndex: number) => Promise<CreationApiResult<Blob>>
  readonly urls?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>
}

export interface WorkbenchDisplaySnapshot {
  readonly materials: readonly ReferenceMaterialView[]
  readonly thumbnails: Readonly<Record<string, string>>
  readonly thumbnailStates: Readonly<Record<string, MaterialThumbnailState>>
}

export const emptyWorkbenchDisplaySnapshot: WorkbenchDisplaySnapshot = {
  materials: [],
  thumbnails: {},
  thumbnailStates: {}
}

export interface PendingMaterialFile {
  readonly file: File
}

function pendingMaterialView(id: string, file: File): ReferenceMaterialView {
  return {
    id,
    kind: file.type.startsWith('video/')
      ? 'video'
      : file.type.startsWith('audio/')
        ? 'audio'
        : 'image',
    fileName: file.name,
    mimeType: file.type,
    byteSize: file.size,
    widthPx: null,
    heightPx: null,
    pixelCount: null,
    durationMs: null,
    checksumSha256: '',
    claimsVersion: 0,
    createdAt: new Date(0).toISOString()
  }
}

export class WorkbenchDisplayController {
  readonly #deps: WorkbenchDisplayDeps
  readonly #materialUrls: MaterialUrlOwner
  #materials: readonly ReferenceMaterialView[] = []
  #thumbnails: Readonly<Record<string, string>> = {}
  #thumbnailStates: Readonly<Record<string, MaterialThumbnailState>> = {}
  #materialIds: ReadonlySet<string> = new Set()
  #thumbnailIds: ReadonlySet<string> = new Set()
  #pendingFiles = new Map<string, PendingMaterialFile>()
  #thumbnailLoad = 0
  #thumbnailRequests = new Map<string, number>()
  #thumbnailConsumers = new Map<string, number>()
  #resultBlobCache: ResultBlobCache | null = null
  #active = false
  #snapshot: WorkbenchDisplaySnapshot = emptyWorkbenchDisplaySnapshot
  readonly #listeners = new Set<() => void>()

  constructor(deps: WorkbenchDisplayDeps) {
    this.#deps = deps
    this.#materialUrls = new MaterialUrlOwner(deps.urls ?? URL)
  }

  /** Re-asserts liveness; StrictMode's effect replay re-runs this on the
   * same instance after its cleanup disposed one display generation. */
  activate(): void {
    this.#active = true
  }

  /** Ends the mounted lifecycle: bumps the generation, stops in-flight
   * loads, and revokes every owned URL. The instance stays reusable. */
  dispose(): void {
    this.#active = false
    this.#thumbnailLoad += 1
    this.#thumbnailRequests.clear()
    this.#thumbnailConsumers.clear()
    this.#materialUrls.dispose()
    this.#resultBlobCache?.dispose()
  }

  subscribe(notify: () => void): () => void {
    this.#listeners.add(notify)
    return () => {
      this.#listeners.delete(notify)
    }
  }

  getSnapshot(): WorkbenchDisplaySnapshot {
    return this.#snapshot
  }

  /** The single context-switch ritual: drops every pending local file,
   * retires all leases and in-flight loads, revokes all URLs, and clears
   * the three display snapshots. Same-tick fresh via getSnapshot. */
  reset(): void {
    this.#thumbnailLoad += 1
    this.#pendingFiles.clear()
    this.#thumbnailRequests.clear()
    this.#thumbnailConsumers.clear()
    this.#materialUrls.dispose()
    this.#resultBlobCache?.dispose()
    this.#resultBlobCache = null
    this.#materials = []
    this.#materialIds = new Set()
    this.#thumbnailIds = new Set()
    this.#thumbnails = {}
    this.#thumbnailStates = {}
    this.#changed()
  }

  /** The displayed context's server page landed (existing-session detail
   * plus still-staged local views merged by the caller). */
  replaceMaterials(views: readonly ReferenceMaterialView[]): void {
    this.#materials = views
    this.#materialIds = new Set(views.map((view) => view.id))
    this.#changed()
  }

  /** Adds one device-local file as a pending material with an immediate
   * image preview URL; its real upload is the caller's business action. */
  registerPending(id: string, file: File): ReferenceMaterialView {
    const previewUrl = file.type.startsWith('image/')
      ? this.#materialUrls.replaceThumbnail(id, file)
      : null
    this.#pendingFiles.set(id, { file })
    const material = pendingMaterialView(id, file)
    this.#materials = [...this.#materials, material]
    this.#materialIds = new Set([...this.#materialIds, id])
    if (previewUrl !== null) {
      this.#thumbnails = { ...this.#thumbnails, [id]: previewUrl }
      this.#thumbnailIds = new Set([...this.#thumbnailIds, id])
      void loadImageDimensions(previewUrl).then((dimensions) => {
        if (dimensions === null || !this.#active || !this.#pendingFiles.has(id)) return
        const withDimensions = (entry: ReferenceMaterialView): ReferenceMaterialView =>
          entry.id === id
            ? {
                ...entry,
                widthPx: dimensions.width,
                heightPx: dimensions.height,
                pixelCount: dimensions.width * dimensions.height
              }
            : entry
        this.#materials = this.#materials.map(withDimensions)
        this.#changed()
      })
    }
    this.#changed()
    return material
  }

  /** Pending files keyed by their synthetic material id; the submit chain
   * freezes them in reference order plus deck leftovers. */
  pendingFiles(): ReadonlyMap<string, PendingMaterialFile> {
    return this.#pendingFiles
  }

  /** Drops one pending file's local records and revokes its preview URL. */
  dropPending(materialId: string): void {
    if (!this.#pendingFiles.has(materialId)) return
    this.#pendingFiles.delete(materialId)
    this.#materialUrls.releaseMaterial(materialId)
    this.#deleteThumbnailEntry(materialId)
  }

  /** Drops one material from every local record — thumbnail entry and owned
   * object URL included; a stale entry would leave consumers holding a
   * revoked URL. */
  forget(materialId: string): void {
    this.#materials = this.#materials.filter((material) => material.id !== materialId)
    this.#materialIds = new Set([...this.#materialIds].filter((id) => id !== materialId))
    this.#thumbnailConsumers.delete(materialId)
    this.#materialUrls.releaseMaterial(materialId)
    this.#deleteThumbnailEntry(materialId)
  }

  requestThumbnail(materialId: string): void {
    const load = this.#thumbnailLoad
    const material = this.#materials.find((candidate) => candidate.id === materialId)
    if (
      material?.kind !== 'image' ||
      (this.#thumbnailConsumers.get(materialId) ?? 0) === 0 ||
      this.#thumbnailIds.has(materialId) ||
      this.#thumbnailRequests.get(materialId) === load
    ) {
      return
    }
    this.#thumbnailRequests.set(materialId, load)
    this.#setThumbnailState(materialId, 'loading')
    const isCurrent = (): boolean =>
      this.#active &&
      load === this.#thumbnailLoad &&
      this.#materialIds.has(materialId) &&
      (this.#thumbnailConsumers.get(materialId) ?? 0) > 0
    const pendingFile = this.#pendingFiles.get(materialId)?.file
    const blob: Promise<Blob | null> =
      pendingFile !== undefined
        ? Promise.resolve(pendingFile)
        : this.#deps
            .loadMaterialBlob(materialId)
            .then((result) => (result.outcome === 'succeeded' ? result.value : null))
    void blob
      .then((value) => {
        if (!isCurrent()) return
        if (value === null) {
          this.#setThumbnailState(materialId, 'failed')
          return
        }
        const url = this.#materialUrls.replaceThumbnail(materialId, value)
        this.#thumbnailIds = new Set([...this.#thumbnailIds, materialId])
        this.#thumbnails = { ...this.#thumbnails, [materialId]: url }
        this.#setThumbnailState(materialId, 'ready')
      })
      .catch(() => {
        if (isCurrent()) this.#setThumbnailState(materialId, 'failed')
      })
      .finally(() => {
        if (this.#thumbnailRequests.get(materialId) === load) {
          this.#thumbnailRequests.delete(materialId)
        }
      })
  }

  /** Holds one thumbnail while a mounted presentation can paint it. */
  retain(materialId: string): () => void {
    const load = this.#thumbnailLoad
    this.#thumbnailConsumers.set(materialId, (this.#thumbnailConsumers.get(materialId) ?? 0) + 1)
    this.requestThumbnail(materialId)
    let released = false
    return () => {
      if (released) return
      released = true
      // A release from a retired generation must not touch the new one.
      if (load !== this.#thumbnailLoad) return
      const consumers = this.#thumbnailConsumers.get(materialId) ?? 0
      if (consumers > 1) {
        this.#thumbnailConsumers.set(materialId, consumers - 1)
        return
      }
      this.#thumbnailConsumers.delete(materialId)
      this.#materialUrls.releaseMaterial(materialId)
      this.#thumbnailIds = new Set(
        [...this.#thumbnailIds].filter((candidate) => candidate !== materialId)
      )
      if (!this.#active) return
      this.#deleteThumbnailEntry(materialId)
    }
  }

  /** Leases one succeeded slot's verified display URL until its card
   * releases it (ADR-0018 byte-budgeted cache). */
  acquireResultBlobUrl(taskId: string, slotIndex: number): Promise<ResultBlobUrlLease | null> {
    return this.#ensureResultBlobCache().acquireObjectUrl(taskId, slotIndex)
  }

  resultBlob(taskId: string, slotIndex: number): Promise<Blob | null> {
    return this.#ensureResultBlobCache().blob(taskId, slotIndex)
  }

  /** Reads one server-backed or pending local Reference Material for UI
   * presentation. */
  async loadMaterialPreviewBlob(materialId: string, signal?: AbortSignal): Promise<Blob | null> {
    const pending = this.#pendingFiles.get(materialId)?.file
    if (pending !== undefined) return pending
    const result = await this.#deps.loadMaterialBlob(materialId, signal)
    return result.outcome === 'succeeded' ? result.value : null
  }

  #ensureResultBlobCache(): ResultBlobCache {
    if (this.#resultBlobCache === null) {
      this.#resultBlobCache = new ResultBlobCache(
        async (taskId, slotIndex) => {
          const result = await this.#deps.loadResultBlob(taskId, slotIndex)
          return result.outcome === 'succeeded' ? result.value : null
        },
        { urls: this.#deps.urls ?? URL }
      )
    }
    return this.#resultBlobCache
  }

  #setThumbnailState(materialId: string, state: MaterialThumbnailState): void {
    this.#thumbnailStates = { ...this.#thumbnailStates, [materialId]: state }
    this.#changed()
  }

  #deleteThumbnailEntry(materialId: string): void {
    if (!(materialId in this.#thumbnails) && !(materialId in this.#thumbnailStates)) return
    const thumbnails = { ...this.#thumbnails }
    delete thumbnails[materialId]
    this.#thumbnails = thumbnails
    const states = { ...this.#thumbnailStates }
    delete states[materialId]
    this.#thumbnailStates = states
    this.#thumbnailIds = new Set(
      [...this.#thumbnailIds].filter((candidate) => candidate !== materialId)
    )
    this.#changed()
  }

  #changed(): void {
    this.#snapshot = {
      materials: this.#materials,
      thumbnails: this.#thumbnails,
      thumbnailStates: this.#thumbnailStates
    }
    for (const notify of [...this.#listeners]) notify()
  }
}
