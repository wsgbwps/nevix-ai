import {
  createCapabilityManifestClient,
  type CapabilityManifest
} from '../api/capability-manifest-http'
import {
  createCreationClient,
  type CreationApiResult,
  type CreationSessionView,
  type CreateMaterialFromResultInput,
  type MaterialPage,
  type DisplayUrlView,
  type ReferenceMaterialView,
  type SessionDetailView,
  type SessionPage
} from '../api/go-creation-http'
import {
  createGenerationTaskClient,
  openCreationEventStream,
  type GenerationTaskDetail,
  type TaskDeletionResult,
  type TaskListPageRequest,
  type TaskPage,
  type TaskSubmitInput
} from '../api/generation-task-http'
import { createAssetLibraryClient, type AssetLibraryPorts } from '../api/asset-library-http'
import { createInspirationClient, type InspirationPorts } from '../api/inspiration-http'
import type {
  CreationReferenceMaterialUploadAbortResult,
  CreationReferenceMaterialUploadRecovery,
  CreationReferenceMaterialUploadResult
} from '../../../../../shared/ipc/creation/types'

/** How every trusted call sources its credential: per operation, never cached.
 * Structurally matches the authentication Feature's session acquisition so
 * no peer-feature import is needed here. */
export type TokenSource = () => Promise<{ readonly token: string } | undefined>

export interface MaterialUploadOptions {
  readonly signal?: AbortSignal
  readonly idempotencyKey?: string
  readonly onLease?: (recovery: Required<CreationReferenceMaterialUploadRecovery>) => void
  readonly onProgress?: (progress: {
    readonly sentBytes: number
    readonly totalBytes: number
  }) => void
}

/**
 * The Workbench's business seam: components see only these ports, so tests drive deterministic
 * fakes while production wires the real trusted-data-plane client. Material lists are
 * cursor-drained in production; Creation Session Navigation deliberately consumes only the newest
 * server page (50 sessions, ADR-0007).
 */

/** A server page projected onto the drain helper's shape. */
interface PageOf<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}

/** A hostile or broken cursor chain ends at this many pages, not forever. */
const maxListPages = 20

async function drainPages<T>(
  fetchPage: (cursor?: string | null) => Promise<CreationApiResult<PageOf<T>>>
): Promise<CreationApiResult<PageOf<T>>> {
  const collected: T[] = []
  let cursor: string | null | undefined = undefined
  for (let page = 0; page < maxListPages; page++) {
    const result = await fetchPage(cursor)
    if (result.outcome !== 'succeeded') return result
    collected.push(...result.value.items)
    if (result.value.nextCursor === null) {
      return { outcome: 'succeeded', value: { items: collected, nextCursor: null } }
    }
    cursor = result.value.nextCursor
  }
  // An unterminated cursor chain is a failed read: partial data must never
  // masquerade as the authoritative collection.
  return { outcome: 'network-failure' }
}
export interface CreationWorkspacePorts extends AssetLibraryPorts, InspirationPorts {
  readonly listSessions: (cursor?: string | null) => Promise<CreationApiResult<SessionPage>>
  readonly createSession: (name?: string) => Promise<CreationApiResult<CreationSessionView>>
  readonly renameSession: (
    sessionId: string,
    name: string
  ) => Promise<CreationApiResult<CreationSessionView>>
  readonly deleteSession: (sessionId: string) => Promise<CreationApiResult<void>>
  readonly getSessionDetail: (sessionId: string) => Promise<CreationApiResult<SessionDetailView>>
  readonly listMaterials: (
    sessionId: string,
    cursor?: string | null
  ) => Promise<CreationApiResult<MaterialPage>>
  readonly uploadMaterial: (
    sessionId: string,
    file: File,
    options?: MaterialUploadOptions
  ) => Promise<CreationApiResult<ReferenceMaterialView>>
  readonly recoverMaterialUpload: (
    recovery: CreationReferenceMaterialUploadRecovery,
    signal?: AbortSignal
  ) => Promise<CreationReferenceMaterialUploadResult>
  readonly abortMaterialUpload: (
    recovery: CreationReferenceMaterialUploadRecovery,
    signal?: AbortSignal
  ) => Promise<CreationReferenceMaterialUploadAbortResult>
  readonly createMaterialFromResult: (
    sessionId: string,
    input: CreateMaterialFromResultInput
  ) => Promise<CreationApiResult<ReferenceMaterialView>>
  readonly deleteMaterial: (materialId: string) => Promise<CreationApiResult<void>>
  /** Fetches one owned image material's short-lived presigned thumbnail URL
   * (ADR-0014 renderer display grant). */
  readonly loadThumbnailUrl: (materialId: string) => Promise<CreationApiResult<DisplayUrlView>>
  /** Fetches one owned material's short-lived presigned preview URL
   * (ADR-0014 renderer display grant). */
  readonly loadPreviewUrl: (materialId: string) => Promise<CreationApiResult<DisplayUrlView>>
  readonly loadCapabilityManifest: () => Promise<CreationApiResult<CapabilityManifest>>
  /** Submits one idempotent generation task carrying the full local intent. */
  readonly submitTask: (
    sessionId: string,
    input: TaskSubmitInput
  ) => Promise<CreationApiResult<GenerationTaskDetail>>
  /** Reads one keyset page of the session's tasks; the refresh module follows
   * the cursor itself, so this port never drains pages unlike the list ports. */
  readonly listTasks: (
    sessionId: string,
    page?: TaskListPageRequest
  ) => Promise<CreationApiResult<TaskPage>>
  readonly getTask: (taskId: string) => Promise<CreationApiResult<GenerationTaskDetail>>
  readonly cancelTask: (taskId: string) => Promise<CreationApiResult<GenerationTaskDetail>>
  /** Hides one terminal task and removes its results in one command (ADR-0022). */
  readonly dismissTask: (taskId: string) => Promise<CreationApiResult<TaskDeletionResult>>
  readonly retryTask: (
    taskId: string,
    idempotencyKey: string
  ) => Promise<CreationApiResult<GenerationTaskDetail>>
  /** Streams one succeeded slot's verified output as bytes; display URLs are
   * derived Feature-locally by the result cache, never over this seam. */
  readonly loadResultBlob: (taskId: string, slotIndex: number) => Promise<CreationApiResult<Blob>>
  /** Opens the creator-scoped SSE invalidation stream; returns unsubscribe.
   * onStateChange mirrors liveness so the caller can poll while it is down;
   * onUnauthorized reports a confirmed credential rejection. */
  readonly subscribeEvents: (handlers: {
    onInvalidation: () => void
    onStateChange: (live: boolean) => void
    onUnauthorized: () => void
  }) => () => void
}

/**
 * Production ports for one connected creator: the token is acquired fresh per
 * call, dropped afterwards, and never enters URLs.
 */
export function createCreationWorkspacePorts(
  serverUrl: string,
  acquireSession: TokenSource
): CreationWorkspacePorts {
  async function withToken<T>(
    run: (client: ReturnType<typeof createCreationClient>, token: string) => Promise<T>
  ): Promise<T> {
    const acquisition = await acquireSession()
    if (!acquisition) throw new Error('creation: session became unavailable')
    const client = createCreationClient(serverUrl)
    return run(client, acquisition.token)
  }

  async function withTaskToken<T>(
    run: (client: ReturnType<typeof createGenerationTaskClient>, token: string) => Promise<T>
  ): Promise<T> {
    const acquisition = await acquireSession()
    if (!acquisition) throw new Error('creation: session became unavailable')
    return run(createGenerationTaskClient(serverUrl), acquisition.token)
  }

  async function withAssetToken<T>(
    run: (client: ReturnType<typeof createAssetLibraryClient>, token: string) => Promise<T>
  ): Promise<T> {
    const acquisition = await acquireSession()
    if (!acquisition) throw new Error('creation: session became unavailable')
    return run(createAssetLibraryClient(serverUrl), acquisition.token)
  }

  async function withInspirationToken<T>(
    run: (client: ReturnType<typeof createInspirationClient>, token: string) => Promise<T>
  ): Promise<T> {
    const acquisition = await acquireSession()
    if (!acquisition) throw new Error('creation: session became unavailable')
    return run(createInspirationClient(serverUrl), acquisition.token)
  }

  return {
    listAssets: (page) => withAssetToken((client, token) => client.list(token, page)),
    getAsset: (assetId) => withAssetToken((client, token) => client.get(token, assetId)),
    loadAssetDisplay: (assetId, purpose, options) =>
      withAssetToken((client, token) => client.loadDisplay(token, assetId, purpose, options)),
    downloadAssetContent: (assetId, checksumSha256, options) =>
      withAssetToken((client, token) =>
        client.downloadContent(token, assetId, checksumSha256, options)
      ),
    deleteAsset: (assetId) => withAssetToken((client, token) => client.delete(token, assetId)),
    listInspiration: (page) => withInspirationToken((client, token) => client.list(token, page)),
    getInspirationDetail: (item) =>
      withInspirationToken((client, token) => client.get(token, item)),
    loadInspirationContent: (item, options) =>
      withInspirationToken((client, token) => client.loadContent(token, item, options)),
    loadInspirationReferencePreview: (item, referenceId) =>
      withInspirationToken((client, token) =>
        client.loadReferencePreview(token, item, referenceId)
      ),
    publishAsset: (assetId, idempotencyKey) =>
      withInspirationToken((client, token) => client.publish(token, assetId, idempotencyKey)),
    withdrawPublication: (publicationId) =>
      withInspirationToken((client, token) => client.withdraw(token, publicationId)),
    createPublicationSimilar: (publicationId, idempotencyKey) =>
      withInspirationToken((client, token) =>
        client.createSimilar(token, publicationId, idempotencyKey)
      ),
    restrictAsset: (assetId) =>
      withInspirationToken((client, token) => client.restrictAsset(token, assetId)),
    releaseAsset: (assetId) =>
      withInspirationToken((client, token) => client.releaseAsset(token, assetId)),
    restrictPublication: (publicationId) =>
      withInspirationToken((client, token) => client.restrictPublication(token, publicationId)),
    releasePublication: (publicationId) =>
      withInspirationToken((client, token) => client.releasePublication(token, publicationId)),
    listSessions: (cursor) => withToken((client, token) => client.listSessions(token, cursor)),
    createSession: (name) => withToken((client, token) => client.createSession(token, name)),
    renameSession: (sessionId, name) =>
      withToken((client, token) => client.renameSession(token, sessionId, name)),
    deleteSession: (sessionId) =>
      withToken((client, token) => client.deleteSession(token, sessionId)),
    getSessionDetail: (sessionId) =>
      withToken((client, token) => client.getSessionDetail(token, sessionId)),
    listMaterials: (sessionId, cursor) =>
      withToken(async (client, token) => {
        if (cursor) return client.listMaterials(token, sessionId, cursor)
        const drained = await drainPages((pageCursor) =>
          client.listMaterials(token, sessionId, pageCursor).then(mapMaterialPage)
        )
        return unmapMaterialPage(drained)
      }),
    uploadMaterial: async (sessionId, file, options) => {
      const operationId = crypto.randomUUID()
      const cancel = (): void => {
        void window.api.creation.cancelReferenceMaterialUpload(operationId).catch(() => undefined)
      }
      options?.signal?.addEventListener('abort', cancel, { once: true })
      try {
        if (options?.signal?.aborted) {
          cancel()
          return { outcome: 'request-rejected', code: 'upload_cancelled' }
        }
        return await window.api.creation.uploadReferenceMaterial(
          operationId,
          sessionId,
          file,
          options?.onProgress,
          {
            idempotencyKey: options?.idempotencyKey ?? operationId,
            onLease: options?.onLease
          }
        )
      } finally {
        options?.signal?.removeEventListener('abort', cancel)
      }
    },
    recoverMaterialUpload: async (recovery, signal) => {
      const operationId = crypto.randomUUID()
      const cancel = (): void => {
        void window.api.creation.cancelReferenceMaterialUpload(operationId).catch(() => undefined)
      }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        if (signal?.aborted) {
          cancel()
          return { outcome: 'request-rejected', code: 'upload_cancelled' }
        }
        return await window.api.creation.recoverReferenceMaterialUpload(operationId, recovery)
      } finally {
        signal?.removeEventListener('abort', cancel)
      }
    },
    abortMaterialUpload: async (recovery, signal) => {
      const operationId = crypto.randomUUID()
      const cancel = (): void => {
        void window.api.creation.cancelReferenceMaterialUpload(operationId).catch(() => undefined)
      }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        if (signal?.aborted) {
          cancel()
          return { outcome: 'request-rejected', code: 'upload_cancelled' }
        }
        return await window.api.creation.abortReferenceMaterialUpload(operationId, recovery)
      } finally {
        signal?.removeEventListener('abort', cancel)
      }
    },
    createMaterialFromResult: (sessionId, input) =>
      withToken((client, token) => client.createMaterialFromResult(token, sessionId, input)),
    deleteMaterial: (materialId) =>
      withToken((client, token) => client.deleteMaterial(token, materialId)),
    loadThumbnailUrl: (materialId) =>
      withToken((client, token) => client.loadMaterialThumbnailUrl(token, materialId)),
    loadPreviewUrl: (materialId) =>
      withToken((client, token) => client.loadMaterialPreviewUrl(token, materialId)),
    // The manifest client shares the request helper's failure mapping; only
    // the parser differs, so it rides the same per-call token acquisition.
    loadCapabilityManifest: () =>
      withToken((_client, token) => createCapabilityManifestClient(serverUrl).lookup(token)),
    submitTask: (sessionId, input) =>
      withTaskToken((client, token) => client.submitTask(token, sessionId, input)),
    listTasks: (sessionId, page) =>
      withTaskToken((client, token) => client.listTasks(token, sessionId, page)),
    getTask: (taskId) => withTaskToken((client, token) => client.getTask(token, taskId)),
    cancelTask: (taskId) => withTaskToken((client, token) => client.cancelTask(token, taskId)),
    dismissTask: (taskId) => withTaskToken((client, token) => client.dismissTask(token, taskId)),
    retryTask: (taskId, idempotencyKey) =>
      withTaskToken((client, token) => client.retryTask(token, taskId, idempotencyKey)),
    loadResultBlob: (taskId, slotIndex) =>
      withTaskToken((client, token) => client.loadResultBlob(token, taskId, slotIndex)),
    subscribeEvents: (handlers) =>
      openCreationEventStream(
        serverUrl,
        async () => {
          const acquisition = await acquireSession()
          return acquisition?.token ?? null
        },
        handlers
      )
  }
}

function mapMaterialPage(
  page: CreationApiResult<MaterialPage>
): CreationApiResult<PageOf<ReferenceMaterialView>> {
  if (page.outcome !== 'succeeded') return page
  return {
    outcome: 'succeeded',
    value: { items: page.value.materials, nextCursor: page.value.nextCursor }
  }
}

function unmapMaterialPage(
  drained: CreationApiResult<PageOf<ReferenceMaterialView>>
): CreationApiResult<MaterialPage> {
  if (drained.outcome !== 'succeeded') return drained
  return { outcome: 'succeeded', value: { materials: drained.value.items, nextCursor: null } }
}
