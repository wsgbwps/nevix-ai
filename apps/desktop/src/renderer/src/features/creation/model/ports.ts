import {
  createCapabilityManifestClient,
  type CapabilityManifest
} from '../api/capability-manifest-http'
import {
  createCreationClient,
  type CreationApiResult,
  type CreationSessionView,
  type MaterialPage,
  type ReferenceMaterialView,
  type SessionDetailView,
  type SessionDraftInput,
  type SessionDraftView,
  type SessionPage
} from '../api/go-creation-http'
import {
  createGenerationTaskClient,
  openCreationEventStream,
  type GenerationTaskDetail,
  type TaskPage,
  type TaskSubmitInput
} from '../api/generation-task-http'

/** How every trusted call sources its credential: per operation, never cached.
 * Structurally matches the authentication Feature's session acquisition so
 * no peer-feature import is needed here. */
export type TokenSource = () => Promise<{ readonly token: string } | undefined>

/**
 * The Workbench's business seam: the page and its components see only these
 * ports, so component tests drive deterministic fakes while production wires
 * the real trusted-data-plane client.
 *
 * List ports are cursor-drained in production: every page behind the keyset
 * cursor is followed so the caller always receives the complete collection.
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
export interface CreationWorkspacePorts {
  readonly listSessions: (cursor?: string | null) => Promise<CreationApiResult<SessionPage>>
  readonly createSession: (name?: string) => Promise<CreationApiResult<CreationSessionView>>
  readonly renameSession: (
    sessionId: string,
    name: string
  ) => Promise<CreationApiResult<CreationSessionView>>
  readonly deleteSession: (sessionId: string) => Promise<CreationApiResult<void>>
  readonly getSessionDetail: (sessionId: string) => Promise<CreationApiResult<SessionDetailView>>
  readonly saveSessionDraft: (
    sessionId: string,
    draft: SessionDraftInput
  ) => Promise<CreationApiResult<SessionDraftView>>
  readonly listMaterials: (
    sessionId: string,
    cursor?: string | null
  ) => Promise<CreationApiResult<MaterialPage>>
  readonly uploadMaterial: (
    sessionId: string,
    file: File
  ) => Promise<CreationApiResult<ReferenceMaterialView>>
  readonly deleteMaterial: (materialId: string) => Promise<CreationApiResult<void>>
  readonly loadImageBlobUrl: (materialId: string) => Promise<string | null>
  readonly loadCapabilityManifest: () => Promise<CreationApiResult<CapabilityManifest>>
  /** Submits one idempotent generation task from the stored draft. */
  readonly submitTask: (
    sessionId: string,
    input: TaskSubmitInput
  ) => Promise<CreationApiResult<GenerationTaskDetail>>
  readonly listTasks: (sessionId: string) => Promise<CreationApiResult<TaskPage>>
  readonly getTask: (taskId: string) => Promise<CreationApiResult<GenerationTaskDetail>>
  readonly cancelTask: (taskId: string) => Promise<CreationApiResult<GenerationTaskDetail>>
  readonly retryTask: (
    taskId: string,
    idempotencyKey: string
  ) => Promise<CreationApiResult<GenerationTaskDetail>>
  /** Streams one succeeded slot's verified output for display. */
  readonly loadResultBlobUrl: (taskId: string, slotIndex: number) => Promise<string | null>
  /**
   * Opens the creator-scoped SSE invalidation stream; returns unsubscribe.
   * onStateChange mirrors liveness so the caller can poll while it is down.
   */
  readonly subscribeEvents: (handlers: {
    onInvalidation: () => void
    onStateChange: (live: boolean) => void
  }) => () => void
}

/**
 * Builds the production ports for one connected creator. The token is
 * acquired fresh for each call and dropped afterwards; it never enters URLs.
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

  return {
    // First calls drain every page behind the keyset cursor; an explicit
    // cursor fetches exactly that page.
    listSessions: (cursor) =>
      withToken(async (client, token) => {
        if (cursor) return client.listSessions(token, cursor)
        const drained = await drainPages((pageCursor) =>
          client.listSessions(token, pageCursor).then(mapSessionPage)
        )
        return unmapSessionPage(drained)
      }),
    createSession: (name) => withToken((client, token) => client.createSession(token, name)),
    renameSession: (sessionId, name) =>
      withToken((client, token) => client.renameSession(token, sessionId, name)),
    deleteSession: (sessionId) =>
      withToken((client, token) => client.deleteSession(token, sessionId)),
    getSessionDetail: (sessionId) =>
      withToken((client, token) => client.getSessionDetail(token, sessionId)),
    saveSessionDraft: (sessionId, draft) =>
      withToken((client, token) => client.saveSessionDraft(token, sessionId, draft)),
    listMaterials: (sessionId, cursor) =>
      withToken(async (client, token) => {
        if (cursor) return client.listMaterials(token, sessionId, cursor)
        const drained = await drainPages((pageCursor) =>
          client.listMaterials(token, sessionId, pageCursor).then(mapMaterialPage)
        )
        return unmapMaterialPage(drained)
      }),
    uploadMaterial: (sessionId, file) =>
      withToken((client, token) => client.uploadMaterial(token, sessionId, file)),
    deleteMaterial: (materialId) =>
      withToken((client, token) => client.deleteMaterial(token, materialId)),
    loadImageBlobUrl: (materialId) =>
      withToken((client, token) => client.loadImageBlobUrl(token, materialId)),
    // The manifest client shares the request helper's failure mapping; only
    // the parser differs, so it rides the same per-call token acquisition.
    loadCapabilityManifest: () =>
      withToken((_client, token) => createCapabilityManifestClient(serverUrl).lookup(token)),
    submitTask: (sessionId, input) =>
      withTaskToken((client, token) => client.submitTask(token, sessionId, input)),
    listTasks: (sessionId) => withTaskToken((client, token) => client.listTasks(token, sessionId)),
    getTask: (taskId) => withTaskToken((client, token) => client.getTask(token, taskId)),
    cancelTask: (taskId) => withTaskToken((client, token) => client.cancelTask(token, taskId)),
    retryTask: (taskId, idempotencyKey) =>
      withTaskToken((client, token) => client.retryTask(token, taskId, idempotencyKey)),
    loadResultBlobUrl: (taskId, slotIndex) =>
      withTaskToken((client, token) => client.loadResultBlobUrl(token, taskId, slotIndex)),
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

function mapSessionPage(
  page: CreationApiResult<SessionPage>
): CreationApiResult<PageOf<CreationSessionView>> {
  if (page.outcome !== 'succeeded') return page
  return {
    outcome: 'succeeded',
    value: { items: page.value.sessions, nextCursor: page.value.nextCursor }
  }
}

function unmapSessionPage(
  drained: CreationApiResult<PageOf<CreationSessionView>>
): CreationApiResult<SessionPage> {
  if (drained.outcome !== 'succeeded') return drained
  return { outcome: 'succeeded', value: { sessions: drained.value.items, nextCursor: null } }
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
