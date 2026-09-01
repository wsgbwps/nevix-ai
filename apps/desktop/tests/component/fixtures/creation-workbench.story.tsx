import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { createI18nOptions } from '../../../src/shared/i18n/i18next-options'
import {
  creationResources,
  CreationRuntimeContext,
  CreationWorkbenchPage,
  type CreationWorkspacePorts
} from '../../../src/renderer/src/features/creation'
import type {
  CreationApiResult,
  CreationSessionView,
  ReferenceMaterialView,
  SessionDraftInput
} from '../../../src/renderer/src/features/creation/api/go-creation-http'
import type {
  CapabilityManifest,
  ImageReferenceEnvelope
} from '../../../src/renderer/src/features/creation/api/capability-manifest-http'
import type {
  GenerationTaskDetail,
  GenerationTaskView
} from '../../../src/renderer/src/features/creation/api/generation-task-http'

/**
 * Black-box composition for the Creation Workbench public surface (issues
 * #156 / #177): the exported page mounted with scripted in-memory ports —
 * including the session draft store and the Capability Manifest. Tests drive
 * visible UI and observe caller-visible port calls; no internal store or hook
 * is exposed beyond a narrow assertion handle.
 */

const testI18n = i18next.createInstance()
await testI18n.init(
  createI18nOptions({
    language: 'en',
    resources: creationResources,
    defaultNS: 'creation',
    environment: 'test'
  })
)

const sessionA: CreationSessionView = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  name: 'Spring campaign',
  createdAt: '2026-08-20T10:00:00Z',
  updatedAt: '2026-08-21T10:00:00Z'
}
const sessionB: CreationSessionView = {
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  name: '',
  createdAt: '2026-08-22T10:00:00Z',
  updatedAt: '2026-08-22T10:00:00Z'
}

function material(partial: {
  id: string
  kind: ReferenceMaterialView['kind']
  fileName: string
}): ReferenceMaterialView {
  return {
    id: partial.id,
    kind: partial.kind,
    fileName: partial.fileName,
    mimeType:
      partial.kind === 'image'
        ? 'image/png'
        : partial.kind === 'video'
          ? 'video/mp4'
          : 'audio/mpeg',
    byteSize: 1024,
    widthPx: partial.kind === 'audio' ? null : 24,
    heightPx: partial.kind === 'audio' ? null : 16,
    pixelCount: partial.kind === 'image' ? 384 : null,
    durationMs: partial.kind === 'image' ? null : 3000,
    checksumSha256: 'aa'.repeat(32),
    claimsVersion: 1,
    createdAt: '2026-08-23T08:00:00Z'
  }
}

const materialOne = material({
  id: 'cccccccc-0000-4000-8000-000000000003',
  kind: 'image',
  fileName: 'poster.png'
})
const materialTwo = material({
  id: 'dddddddd-0000-4000-8000-000000000004',
  kind: 'image',
  fileName: 'banner.png'
})

const thumbnailUrl =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="64"><rect width="100%" height="100%" fill="#88f"/></svg>'
  )

function imageEnvelope(min: number, max: number): ImageReferenceEnvelope {
  return {
    count: { min, max },
    formats: ['jpeg', 'png', 'webp'],
    maxBytes: 8 * 1024 * 1024,
    minPx: 256,
    maxPx: 6000,
    maxPixels: 36_000_000,
    minAspect: 1 / 3,
    maxAspect: 3
  }
}

const noReferences = { total: { min: 0, max: 0 } }

/** The V1 manifest as the server publishes it with both media active. */
const activeManifest: CapabilityManifest = {
  schemaVersion: 2,
  manifestVersion: 3,
  updatedAt: '2026-08-29T10:00:00Z',
  image: {
    available: true,
    reason: null,
    action: null,
    models: [
      {
        model: 'doubao-seedream-5.0-pro',
        resolutions: ['1K', '1.5K', '2K'],
        defaultResolution: '2K'
      },
      {
        model: 'doubao-seedream-5.0-n',
        resolutions: ['2K', '3K', '4K'],
        defaultResolution: '2K'
      }
    ],
    modes: [
      { id: 'text-to-image', referenceMaterial: noReferences },
      {
        id: 'reference-image',
        referenceMaterial: { total: { min: 1, max: 4 }, image: imageEnvelope(1, 4) }
      }
    ],
    ratios: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'],
    quantities: [1, 2, 3, 4],
    defaults: { ratio: '1:1', quantity: 1 },
    prompt: { minChars: 1, maxChars: 2000 }
  },
  video: {
    available: true,
    reason: null,
    action: null,
    models: [
      {
        model: 'doubao-seedance-2-5',
        resolutions: ['480p', '720p', '1080p'],
        defaultResolution: '720p'
      }
    ],
    modes: [
      { id: 'text-to-video', referenceMaterial: noReferences },
      {
        id: 'first-frame',
        referenceMaterial: { total: { min: 1, max: 1 }, image: imageEnvelope(1, 1) }
      },
      {
        id: 'first-last-frame',
        referenceMaterial: { total: { min: 1, max: 2 }, image: imageEnvelope(1, 2) }
      },
      {
        id: 'omni-reference',
        referenceMaterial: {
          total: { min: 1, max: 4 },
          image: imageEnvelope(0, 4),
          video: {
            count: { min: 0, max: 1 },
            formats: ['mp4'],
            maxBytes: 200 * 1024 * 1024,
            minSeconds: 2,
            maxSeconds: 30
          },
          audio: {
            count: { min: 0, max: 1 },
            formats: ['mp3', 'wav', 'm4a'],
            maxBytes: 50 * 1024 * 1024,
            minSeconds: 2,
            maxSeconds: 30
          }
        }
      }
    ],
    durations: [5, 10],
    defaults: { duration: 5 },
    prompt: { minChars: 1, maxChars: 2000 }
  }
}

export interface DeckTestControls {
  saveDraftCalls(): ReadonlyArray<{ sessionId: string; draft: unknown }>
  deleteMaterialCalls(): string[]
  uploadCalls(): ReadonlyArray<{ sessionId: string; name: string }>
  taskCalls(): ReadonlyArray<{ sessionId: string; idempotencyKey: string }>
  retryCalls(): ReadonlyArray<{ taskId: string; idempotencyKey: string }>
  cancelledIds(): string[]
  releaseManifest(): void
  fireInvalidation(): void
  pushTask(task: ScriptedTask): void
}

declare global {
  interface Window {
    __creationDeckTest?: DeckTestControls
  }
}

function succeeded<T>(value: T): CreationApiResult<T> {
  return { outcome: 'succeeded', value }
}

/** Scripted task behavior: what submitTask does and which tasks pre-exist. */
export interface ScriptedTask extends GenerationTaskView {
  readonly slots: GenerationTaskDetail['slots']
}

export interface TaskScript {
  readonly tasks?: readonly ScriptedTask[]
  /** When set, submitTask rejects with this stable code. */
  readonly submitRejection?: string
}

interface RuntimeOptions {
  readonly manifest: CapabilityManifest | null
  /** When true the manifest call fails like an unreachable server. */
  readonly manifestFails?: boolean
  /** When true the test releases the manifest response explicitly. */
  readonly manifestDeferred?: boolean
  readonly sessions: readonly CreationSessionView[]
  readonly drafts?: Readonly<Record<string, SessionDraftInput | null>>
  readonly materials?: Readonly<Record<string, readonly ReferenceMaterialView[]>>
  readonly taskScript?: TaskScript
}

// Builds the story's ports: an in-memory draft store behind the same
// operations the production wire uses, plus the assertion handle.
function installWorkbenchRuntime(options: RuntimeOptions): CreationWorkspacePorts {
  const drafts = new Map(Object.entries(options.drafts ?? {}))
  const materials = new Map(Object.entries(options.materials ?? {}))
  const savedDrafts = new Map<string, SessionDraftInput>()
  const saveCalls: Array<{ sessionId: string; draft: SessionDraftInput }> = []
  const deletedIds: string[] = []
  const uploadCalls: Array<{ sessionId: string; name: string }> = []
  let releaseManifestResponse: (() => void) | null = null
  const manifestReady = options.manifestDeferred
    ? new Promise<void>((resolve) => {
        releaseManifestResponse = resolve
      })
    : Promise.resolve()
  const taskState: {
    tasks: ScriptedTask[]
    submitCalls: Array<{ sessionId: string; idempotencyKey: string }>
    retryCalls: Array<{ taskId: string; idempotencyKey: string }>
    cancelledIds: string[]
    eventHandlers: { onInvalidation: () => void; onStateChange: (live: boolean) => void } | null
  } = {
    tasks: [],
    submitCalls: [],
    retryCalls: [],
    cancelledIds: [],
    eventHandlers: null
  }
  for (const scripted of options.taskScript?.tasks ?? []) {
    taskState.tasks.push({ ...scripted })
  }

  window.__creationDeckTest = {
    saveDraftCalls: () => saveCalls,
    deleteMaterialCalls: () => deletedIds,
    uploadCalls: () => uploadCalls,
    taskCalls: () => taskState.submitCalls,
    retryCalls: () => taskState.retryCalls,
    cancelledIds: () => taskState.cancelledIds,
    releaseManifest: () => {
      releaseManifestResponse?.()
      releaseManifestResponse = null
    },
    fireInvalidation: () => taskState.eventHandlers?.onInvalidation(),
    pushTask: (task) => {
      taskState.tasks = [task, ...taskState.tasks]
      taskState.eventHandlers?.onInvalidation()
    }
  }

  return {
    listSessions: async () => succeeded({ sessions: options.sessions, nextCursor: null }),
    createSession: async (name) =>
      succeeded({
        ...sessionB,
        id: 'eeeeeeee-0000-4000-8000-000000000007',
        name: name ?? ''
      }),
    renameSession: async () => succeeded(sessionA),
    deleteSession: async () => succeeded(undefined),
    getSessionDetail: async (sessionId) => {
      const session = options.sessions.find((entry) => entry.id === sessionId)
      if (!session) return { outcome: 'request-rejected', code: 'not_found' }
      const stored = savedDrafts.get(sessionId) ?? drafts.get(sessionId) ?? null
      return succeeded({
        id: session.id,
        name: session.name,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        draft: stored === null ? null : { ...stored, references: [...stored.references] }
      })
    },
    saveSessionDraft: async (sessionId, draft) => {
      saveCalls.push({ sessionId, draft: { ...draft, references: [...draft.references] } })
      savedDrafts.set(sessionId, draft)
      return succeeded({ ...draft, references: [...draft.references] })
    },
    listMaterials: async (sessionId) =>
      succeeded({ materials: materials.get(sessionId) ?? [], nextCursor: null }),
    uploadMaterial: async (sessionId, file) => {
      uploadCalls.push({ sessionId, name: file.name })
      const uploaded = material({
        id: 'ffffffff-0000-4000-8000-000000000006',
        kind: 'image',
        fileName: file.name
      })
      materials.set(sessionId, [...(materials.get(sessionId) ?? []), uploaded])
      return succeeded(uploaded)
    },
    deleteMaterial: async (materialId) => {
      deletedIds.push(materialId)
      for (const [sessionId, list] of materials) {
        materials.set(
          sessionId,
          list.filter((entry) => entry.id !== materialId)
        )
      }
      return succeeded(undefined)
    },
    loadImageBlobUrl: async () => thumbnailUrl,
    loadCapabilityManifest: async () => {
      await manifestReady
      return options.manifestFails || options.manifest === null
        ? { outcome: 'network-failure' }
        : succeeded(options.manifest)
    },
    // Generation task kernel (issue #159): in-memory task store behind the
    // same operations, plus an invalidation handle for SSE scenarios.
    submitTask: async (sessionId, input) => {
      taskState.submitCalls.push({ sessionId, idempotencyKey: input.idempotencyKey })
      if (options.taskScript?.submitRejection !== undefined) {
        return { outcome: 'request-rejected', code: options.taskScript.submitRejection }
      }
      const task: ScriptedTask = {
        id: 'dddddddd-0000-4000-8000-000000000004',
        sessionId,
        status: 'queued',
        mediaType: 'image',
        slotCount: 2,
        cancelRequested: false,
        terminalCause: null,
        createdAt: '2026-08-29T10:00:00Z',
        updatedAt: '2026-08-29T10:00:00Z',
        terminalAt: null,
        slots: [
          { index: 0, status: 'queued', failureReason: null, result: null },
          { index: 1, status: 'queued', failureReason: null, result: null }
        ]
      }
      taskState.tasks = [task, ...taskState.tasks]
      return succeeded({ task, slots: task.slots })
    },
    listTasks: async (sessionId) =>
      succeeded({
        tasks: taskState.tasks
          .filter((task) => task.sessionId === sessionId)
          .map(
            (task): GenerationTaskView => ({
              id: task.id,
              sessionId: task.sessionId,
              status: task.status,
              mediaType: task.mediaType,
              slotCount: task.slotCount,
              cancelRequested: task.cancelRequested,
              terminalCause: task.terminalCause,
              createdAt: task.createdAt,
              updatedAt: task.updatedAt,
              terminalAt: task.terminalAt
            })
          ),
        nextCursor: null
      }),
    getTask: async (taskId) => {
      const task = taskState.tasks.find((entry) => entry.id === taskId)
      if (!task) return { outcome: 'request-rejected', code: 'not_found' }
      return succeeded({ task, slots: task.slots })
    },
    cancelTask: async (taskId) => {
      taskState.cancelledIds.push(taskId)
      const task = taskState.tasks.find((entry) => entry.id === taskId)
      if (!task) return { outcome: 'request-rejected', code: 'not_found' }
      return succeeded({ task, slots: task.slots })
    },
    retryTask: async (taskId, idempotencyKey) => {
      taskState.retryCalls.push({ taskId, idempotencyKey })
      const task = taskState.tasks.find((entry) => entry.id === taskId)
      if (!task) return { outcome: 'request-rejected', code: 'not_found' }
      const retried: ScriptedTask = {
        ...task,
        id: 'dddddddd-0000-4000-8000-000000000005',
        status: 'queued',
        terminalCause: null,
        terminalAt: null,
        slots: task.slots.map((slot) => ({
          ...slot,
          status: 'queued',
          failureReason: null,
          result: null
        }))
      }
      taskState.tasks = [retried, ...taskState.tasks]
      return succeeded({ task: retried, slots: retried.slots })
    },
    loadResultBlobUrl: async () => thumbnailUrl,
    subscribeEvents: (handlers) => {
      taskState.eventHandlers = handlers
      return () => {
        taskState.eventHandlers = null
      }
    }
  }
}

function Frame({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <I18nextProvider i18n={testI18n}>
      <div style={{ height: 600, display: 'flex' }}>{children}</div>
    </I18nextProvider>
  )
}

interface StoryOptions {
  readonly manifest?: CapabilityManifest | null
  readonly manifestFails?: boolean
  readonly manifestDeferred?: boolean
  readonly drafts?: Readonly<Record<string, SessionDraftInput | null>>
  readonly materials?: Readonly<Record<string, readonly ReferenceMaterialView[]>>
  readonly sessions?: readonly CreationSessionView[]
  readonly taskScript?: TaskScript
}

function RuntimeWorkbenchPage({ options }: { readonly options: StoryOptions }): React.JSX.Element {
  const sessions = options.sessions ?? [sessionA, sessionB]
  return (
    <CreationRuntimeContext.Provider
      value={installWorkbenchRuntime({
        manifest: options.manifest === undefined ? activeManifest : options.manifest,
        manifestFails: options.manifestFails,
        manifestDeferred: options.manifestDeferred,
        sessions,
        taskScript: options.taskScript,
        drafts: options.drafts ?? {
          [sessionA.id]: {
            prompt: '夏季跑鞋主图，暖光背景',
            mediaType: 'image',
            manifestVersion: 3,
            updatedAt: '2026-08-29T10:00:00Z',
            model: 'doubao-seedream-5.0-pro',
            mode: 'reference-image',
            ratio: '4:3',
            resolution: '2K',
            quantity: 2,
            durationSeconds: null,
            references: [
              { materialId: materialOne.id, role: 'reference' },
              { materialId: materialTwo.id, role: 'reference' }
            ]
          }
        },
        materials: options.materials ?? {
          [sessionA.id]: [materialOne, materialTwo]
        }
      })}
    >
      <CreationWorkbenchPage />
    </CreationRuntimeContext.Provider>
  )
}

/** The standard story: an active manifest and one session holding materials. */
export function CreationWorkbenchStory(options: StoryOptions = {}): React.JSX.Element {
  return (
    <Frame>
      <RuntimeWorkbenchPage options={options} />
    </Frame>
  )
}

/**
 * Layout-contract story: the real page mounted exactly as the App Shell
 * composes it — a direct child of the shell's flex-col content container
 * (see app/pages/creation-page.tsx). Used to pin that the workbench fills
 * the shell area; it cannot mount the real CreationPage composition because
 * the authentication/connection providers are not CT-mountable.
 */
export function CreationWorkbenchShellStory(options: StoryOptions = {}): React.JSX.Element {
  return (
    <I18nextProvider i18n={testI18n}>
      <div style={{ height: 600 }} className="flex w-full flex-col">
        <div className="flex flex-1 flex-col overflow-auto" data-testid="shell-content">
          <RuntimeWorkbenchPage options={options} />
        </div>
      </div>
    </I18nextProvider>
  )
}
