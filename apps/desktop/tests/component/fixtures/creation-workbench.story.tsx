import { useEffect, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { testI18n } from './creation-workbench-i18n'
import {
  CreationSessionNavigationProvider,
  CreationSessionNavigationSidebar,
  CreationRuntimeContext,
  CreationWorkbenchPage,
  createCreationRuntime,
  type CreationRuntime
} from '../../../src/renderer/src/features/creation'
import { SidebarProvider } from '../../../src/renderer/src/components/ui/sidebar'
import { TooltipProvider } from '../../../src/renderer/src/components/ui/tooltip'
import type {
  CreationApiResult,
  CreationSessionView,
  ReferenceMaterialView
} from '../../../src/renderer/src/features/creation/api/go-creation-http'
import type { LocalDraftRecord } from '../../../src/renderer/src/features/creation/model/draft-store'
import type {
  CapabilityManifest,
  CapabilityModel,
  ImageReferenceEnvelope
} from '../../../src/renderer/src/features/creation/api/capability-manifest-http'
import type {
  GenerationIntent,
  GenerationTaskDetail,
  GenerationTaskView,
  TaskListPageRequest
} from '../../../src/renderer/src/features/creation/api/generation-task-http'
import type { PublicationSimilarResult } from '../../../src/renderer/src/features/creation/api/inspiration-http'
import {
  readLocalDraft,
  removeLocalDraft,
  writeLocalDraft
} from '../../../src/renderer/src/features/creation/model/draft-store'

/**
 * Black-box composition for the Creation Workbench public surface (issues #156 /
 * #177): the exported page mounted with scripted in-memory ports. Tests drive visible
 * UI and observe caller-visible port calls — no internal store or hook is exposed.
 */

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

/** One task-slot result's bytes, fresh per call like the data plane serves them. */
const resultBlob = (): Blob =>
  new Blob(
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="64"><rect width="100%" height="100%" fill="#88f"/></svg>'
    ],
    { type: 'image/svg+xml' }
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

/**
 * Real vendor pixel sizes (豆包生图 OpenAPI x-size-map), so the composer's size row
 * reads exactly what the server publishes for the same selection.
 */
function imageModelSizes(
  tiers: readonly string[],
  sizes: Record<string, Record<string, [number, number]>>
): CapabilityModel['sizes'] {
  return tiers.flatMap((resolution) =>
    Object.entries(sizes[resolution] ?? {}).map(([ratio, [width, height]]) => ({
      resolution,
      ratio,
      width,
      height
    }))
  )
}

const proSizes = imageModelSizes(['1K', '1.5K', '2K'], {
  '1K': { '4:3': [1152, 864], '9:16': [800, 1424] },
  '1.5K': { '4:3': [1792, 1344], '9:16': [1152, 2048] },
  '2K': { '4:3': [2368, 1776], '9:16': [1584, 2816] }
})
const nidSizes = imageModelSizes(['2K', '3K', '4K'], {
  '2K': { '4:3': [2304, 1728], '9:16': [1600, 2848] },
  '3K': { '4:3': [3456, 2592], '9:16': [2304, 4096] },
  '4K': { '4:3': [4704, 3520], '9:16': [3040, 5504] }
})

/** The V1 manifest as the server publishes it with both media active. */
const activeManifest: CapabilityManifest = {
  schemaVersion: 2,
  manifestVersion: 5,
  updatedAt: '2026-08-29T10:00:00Z',
  image: {
    available: true,
    reason: null,
    action: null,
    models: [
      {
        model: 'doubao-seedream-5.0-pro',
        resolutions: ['1K', '1.5K', '2K'],
        defaultResolution: '2K',
        maxReferenceImages: 10,
        sizes: proSizes
      },
      {
        model: 'doubao-seedream-5.0',
        resolutions: ['2K', '3K', '4K'],
        defaultResolution: '2K',
        maxReferenceImages: 14,
        sizes: nidSizes
      }
    ],
    modes: [
      { id: 'text-to-image', referenceMaterial: noReferences },
      {
        id: 'reference-image',
        referenceMaterial: { total: { min: 1, max: 14 }, image: imageEnvelope(1, 14) }
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
        referenceMaterial: {
          total: { min: 1, max: 1 },
          image: { ...imageEnvelope(1, 1), maxBytes: 10 * 1024 * 1024 }
        }
      },
      {
        id: 'first-last-frame',
        referenceMaterial: {
          total: { min: 2, max: 2 },
          image: { ...imageEnvelope(2, 2), maxBytes: 10 * 1024 * 1024 }
        }
      },
      {
        id: 'omni-reference',
        referenceMaterial: {
          total: { min: 1, max: 4 },
          image: { ...imageEnvelope(0, 4), maxBytes: 10 * 1024 * 1024 },
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
    ratios: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
    quantities: [1],
    defaults: { ratio: 'adaptive', quantity: 1, duration: 5 },
    prompt: { minChars: 1, maxChars: 2000 }
  }
}

export interface DeckTestControls {
  /** Reads this device's local draft record for one session key ('new' for composing). */
  draftRecord(key: string): LocalDraftRecord | null
  deleteMaterialCalls(): string[]
  materialUrlCalls(): ReadonlyArray<{ materialId: string }>
  resultBlobTransfers(): ReadonlyArray<{ taskId: string; slotIndex: number }>
  resultReuseCalls(): ReadonlyArray<{
    sessionId: string
    taskId: string
    slotIndex: number
    fileName: string
  }>
  releaseMaterialUrls(): void
  releaseResultBlobs(): void
  releaseMaterialDeletes(): void
  releaseSessionDeletes(): void
  deferNextMaterialList(): void
  materialListCalls(): number
  uploadCalls(): ReadonlyArray<{ sessionId: string; name: string }>
  /** Releases only the oldest held upload, for sequenced resolutions. */
  releaseNextUpload(): void
  taskCalls(): ReadonlyArray<{
    sessionId: string
    idempotencyKey: string
    intent: GenerationIntent
  }>
  retryCalls(): ReadonlyArray<{ taskId: string; idempotencyKey: string }>
  cancelledIds(): string[]
  createSessionCalls(): ReadonlyArray<{ name: string }>
  /** Holds session creations until releaseSessionCreations runs. */
  releaseSessionCreations(): void
  renameCalls(): ReadonlyArray<{ sessionId: string; name: string }>
  deletedSessionIds(): string[]
  releaseManifest(): void
  releaseTaskDetails(): void
  releaseUploads(): void
  releaseSubmissions(): void
  releaseFirstMaterialList(): void
  changeLanguage(language: 'en' | 'zh-CN'): Promise<void>
  fireInvalidation(): void
  pushTask(task: ScriptedTask): void
  /** Replaces one task by id in the scripted store and fires invalidation. */
  updateTask(task: ScriptedTask): void
  /** Drops one task from the scripted store and fires invalidation, like the
   * list projection no longer returning it (ADR-0021). */
  removeTask(taskId: string): void
  /** How many task-list reads crossed the data plane. */
  listTasksCalls(): number
  /** Every task-list read's page request, in call order. */
  listTaskPages(): ReadonlyArray<{ sessionId: string; limit: number; cursor: string | null }>
  /** Task ids in the order their details were read. */
  getTaskCalls(): string[]
  /** Fires the SSE stream's liveness transitions like a real connection. */
  setStreamLive(live: boolean): void
  /** Makes the next count list reads fail like an unreachable server. */
  failListReads(count: number): void
  /** Makes the next count detail reads for one task fail. */
  failDetailReads(taskId: string, count: number): void
  /** Holds the next list response until releaseHeldListResponses runs. */
  holdNextListResponse(): void
  releaseHeldListResponses(): void
  /** Replaces one task by id without firing any SSE notification. */
  replaceTaskSilently(task: ScriptedTask): void
}

declare global {
  interface Window {
    __creationDeckTest?: DeckTestControls
  }
}

function succeeded<T>(value: T): CreationApiResult<T> {
  return { outcome: 'succeeded', value }
}

// A hand-rolled silent WAV: Chromium's <video> and <audio> both load it as a
// data URL (audio-only content, no error event), so media preview tests run
// the success path without any network.
const scriptedSilentWavUrl = (() => {
  const samples = 8000
  const bytes = new Uint8Array(44 + samples)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index))
    }
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true)
  view.setUint32(28, 8000, true)
  view.setUint16(32, 1, true)
  view.setUint16(34, 8, true)
  ascii(36, 'data')
  view.setUint32(40, samples, true)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:audio/wav;base64,${btoa(binary)}`
})()

// The scripted task list pages like the real endpoint (contracts
// listSessionGenerationTasks): (created_at DESC, id DESC) keyset order with a compound
// cursor, so pagination cannot pass against a fixture that dumps every task at once (#195).
const taskCursorOf = (task: GenerationTaskView): string => `${task.createdAt}|${task.id}`

function tasksNewestFirst(a: GenerationTaskView, b: GenerationTaskView): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1
}

/** Scripted task behavior: what submitTask does and which tasks pre-exist. */
export interface ScriptedTask extends GenerationTaskView {
  readonly slots: GenerationTaskDetail['slots']
  /** Optional task facts returned by detail, independent of the list summary. */
  readonly detailTask?: GenerationTaskView
  /** The task's frozen specification; absent details render task-view facts only. */
  readonly specification?: GenerationTaskDetail['specification']
}

function detailOf(task: ScriptedTask): GenerationTaskDetail {
  const specification = task.specification
  return {
    task: task.detailTask ?? task,
    slots: task.slots,
    // The production parser constructs new wire-view objects per response.
    // Mirror that identity churn so lease regressions cannot hide in the adapter.
    specification:
      specification === undefined
        ? null
        : {
            ...specification,
            references: specification.references.map((reference) => ({ ...reference }))
          }
  }
}

export interface TaskScript {
  readonly tasks?: readonly ScriptedTask[]
  readonly taskDetailsDeferred?: boolean
  readonly resultBlobDeferred?: boolean
  readonly resultBlobFailures?: number
  /** When set, submitTask rejects with this stable code. */
  readonly submitRejection?: string
  /** Number of initial task-list reads that fail with a network failure. */
  readonly failListReads?: number
  /** Task ids whose first count detail reads fail with a network failure. */
  readonly failDetailReads?: Readonly<Record<string, number>>
  readonly submitDeferred?: boolean
  readonly submitOutcomes?: readonly ('succeeded' | 'network-failure' | 'accepted-response-lost')[]
}

/** The account id scoping the device-local draft store in this story. */
const storyUserId = 'story-user'

interface RuntimeOptions {
  readonly manifest: CapabilityManifest | null
  /** When true the manifest call fails like an unreachable server. */
  readonly manifestFails?: boolean
  /** When true the test releases the manifest response explicitly. */
  readonly manifestDeferred?: boolean
  readonly sessions: readonly CreationSessionView[]
  /** Seeds the device-local draft store (ADR-0017); null entries clear a key. */
  readonly drafts?: Readonly<Record<string, LocalDraftRecord | null>>
  readonly materials?: Readonly<Record<string, readonly ReferenceMaterialView[]>>
  /** Number of initial display-URL authorizations that should fail. */
  readonly materialUrlFailures?: number
  /** Keeps display-URL authorizations pending until the test releases them. */
  readonly materialUrlDeferred?: boolean
  /** Overrides the scripted image URL so tests can control its network load. */
  readonly materialImageUrl?: string
  readonly materialImageUrls?: readonly string[]
  readonly deleteMaterialDeferred?: boolean
  readonly deleteSessionDeferred?: boolean
  readonly uploadDeferred?: boolean
  readonly uploadOutcome?:
    | 'succeeded'
    | 'network-failure'
    | 'accepted-response-lost'
    | 'request-rejected'
  readonly deferFirstMaterialListFor?: string
  /** Holds each session creation until releaseSessionCreations runs. */
  readonly createSessionDeferred?: boolean
  /** Scripted outcome for every session creation besides succeeded. */
  readonly createSessionOutcome?: 'network-failure' | 'request-rejected'
  readonly taskScript?: TaskScript
  readonly publicationSimilar?: PublicationSimilarResult
}

// Builds the story's runtime: scripted server ports plus the real
// device-local draft store seeded into localStorage, so draft behavior runs
// through its production surface (ADR-0017).
function installWorkbenchRuntime(options: RuntimeOptions): CreationRuntime {
  const materials = new Map(Object.entries(options.materials ?? {}))
  let serverSessions = [...options.sessions]
  for (const [key, record] of Object.entries(options.drafts ?? {})) {
    if (record === null) removeLocalDraft(localStorage, storyUserId, key)
    else writeLocalDraft(localStorage, storyUserId, key, record)
  }
  const deletedIds: string[] = []
  const materialUrlCalls: Array<{ materialId: string }> = []
  const materialUrlReleases = new Set<() => void>()
  const materialDeleteReleases = new Set<() => void>()
  const sessionDeleteReleases = new Set<() => void>()
  const uploadReleases = new Set<() => void>()
  const submissionReleases = new Set<() => void>()
  const sessionCreateReleases = new Set<() => void>()
  // First creation answers with the id the legacy specs pin; later ones increment.
  let nextCreatedSessionSerial = 7
  let releaseFirstMaterialList: (() => void) | null = null
  let firstMaterialListDeferred = options.deferFirstMaterialListFor !== undefined
  let deferNextMaterialList = false
  let materialListCalls = 0
  let remainingMaterialUrlFailures = options.materialUrlFailures ?? 0
  const uploadCalls: Array<{ sessionId: string; name: string }> = []
  // First upload answers with the id the legacy specs pin; later ones increment.
  let uploadSequence = 0
  const createdSessions: Array<{ name: string }> = []
  const renameCalls: Array<{ sessionId: string; name: string }> = []
  const deletedSessionIds: string[] = []
  const resultBlobTransfers: Array<{ taskId: string; slotIndex: number }> = []
  const resultReuseCalls: Array<{
    sessionId: string
    taskId: string
    slotIndex: number
    fileName: string
  }> = []
  const resultBlobReleases = new Set<() => void>()
  let remainingResultBlobFailures = options.taskScript?.resultBlobFailures ?? 0
  let releaseManifestResponse: (() => void) | null = null
  const manifestReady = options.manifestDeferred
    ? new Promise<void>((resolve) => {
        releaseManifestResponse = resolve
      })
    : Promise.resolve()
  let releaseTaskDetailsResponse: (() => void) | null = null
  const taskDetailsReady = options.taskScript?.taskDetailsDeferred
    ? new Promise<void>((resolve) => {
        releaseTaskDetailsResponse = resolve
      })
    : Promise.resolve()
  const taskState: {
    tasks: ScriptedTask[]
    submitCalls: Array<{
      sessionId: string
      idempotencyKey: string
      intent: GenerationIntent
    }>
    retryCalls: Array<{ taskId: string; idempotencyKey: string }>
    cancelledIds: string[]
    listCalls: number
    listPageRequests: Array<{ sessionId: string; limit: number; cursor: string | null }>
    getTaskCalls: string[]
    remainingListFailures: number
    remainingDetailFailures: Map<string, number>
    listHolds: Array<Promise<void>>
    listHoldReleases: Array<() => void>
    submissionsByKey: Map<string, ScriptedTask>
    eventHandlers: {
      onInvalidation: () => void
      onStateChange: (live: boolean) => void
      onUnauthorized: () => void
    } | null
  } = {
    tasks: [],
    submitCalls: [],
    retryCalls: [],
    cancelledIds: [],
    listCalls: 0,
    listPageRequests: [],
    getTaskCalls: [],
    remainingListFailures: options.taskScript?.failListReads ?? 0,
    remainingDetailFailures: new Map(Object.entries(options.taskScript?.failDetailReads ?? {})),
    listHolds: [],
    listHoldReleases: [],
    submissionsByKey: new Map(),
    eventHandlers: null
  }
  for (const scripted of options.taskScript?.tasks ?? []) {
    taskState.tasks.push({ ...scripted })
  }
  const submitOutcomes = [...(options.taskScript?.submitOutcomes ?? [])]

  const releaseAll = (releases: Set<() => void>): void => {
    for (const release of releases) release()
    releases.clear()
  }
  const waitForRelease = (releases: Set<() => void>): Promise<void> =>
    new Promise((resolve) => releases.add(resolve))

  // Use decodable inline media so previews do not enter the error/retry path.
  const scriptedMaterialSvgUrl =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='64'%3E%3Crect width='100%25' height='100%25' fill='%2388f'/%3E%3C/svg%3E"
  const scriptedMaterialKind = (materialId: string): ReferenceMaterialView['kind'] => {
    for (const list of materials.values()) {
      const found = list.find((entry) => entry.id === materialId)
      if (found !== undefined) return found.kind
    }
    return 'image'
  }
  const scriptedMaterialUrl = async (
    materialId: string
  ): Promise<
    | { outcome: 'succeeded'; value: { url: string; expiresAt: string } }
    | { outcome: 'network-failure' }
  > => {
    materialUrlCalls.push({ materialId })
    const imageUrl =
      options.materialImageUrls?.[materialUrlCalls.length - 1] ??
      options.materialImageUrl ??
      scriptedMaterialSvgUrl
    if (options.materialUrlDeferred) await waitForRelease(materialUrlReleases)
    if (remainingMaterialUrlFailures > 0) {
      remainingMaterialUrlFailures -= 1
      return { outcome: 'network-failure' }
    }
    return succeeded({
      url:
        scriptedMaterialKind(materialId) === 'image'
          ? imageUrl
          : `${scriptedSilentWavUrl}#grant-${materialUrlCalls.length}`,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
    })
  }

  window.__creationDeckTest = {
    draftRecord: (key) => readLocalDraft(localStorage, storyUserId, key),
    deleteMaterialCalls: () => deletedIds,
    materialUrlCalls: () => materialUrlCalls,
    resultBlobTransfers: () => resultBlobTransfers,
    resultReuseCalls: () => resultReuseCalls,
    releaseMaterialUrls: () => {
      for (const release of materialUrlReleases) release()
      materialUrlReleases.clear()
    },
    releaseResultBlobs: () => {
      for (const release of resultBlobReleases) release()
      resultBlobReleases.clear()
    },
    releaseMaterialDeletes: () => releaseAll(materialDeleteReleases),
    releaseSessionDeletes: () => releaseAll(sessionDeleteReleases),
    deferNextMaterialList: () => {
      deferNextMaterialList = true
    },
    materialListCalls: () => materialListCalls,
    uploadCalls: () => uploadCalls,
    taskCalls: () => taskState.submitCalls,
    retryCalls: () => taskState.retryCalls,
    cancelledIds: () => taskState.cancelledIds,
    createSessionCalls: () => createdSessions,
    releaseSessionCreations: () => releaseAll(sessionCreateReleases),
    renameCalls: () => renameCalls,
    deletedSessionIds: () => deletedSessionIds,
    releaseManifest: () => {
      releaseManifestResponse?.()
      releaseManifestResponse = null
    },
    releaseTaskDetails: () => {
      releaseTaskDetailsResponse?.()
      releaseTaskDetailsResponse = null
    },
    releaseUploads: () => releaseAll(uploadReleases),
    releaseNextUpload: (): void => {
      uploadReleases.values().next().value?.()
    },
    releaseSubmissions: () => releaseAll(submissionReleases),
    releaseFirstMaterialList: () => {
      releaseFirstMaterialList?.()
      releaseFirstMaterialList = null
    },
    changeLanguage: async (language) => {
      await testI18n.changeLanguage(language)
    },
    fireInvalidation: () => taskState.eventHandlers?.onInvalidation(),
    pushTask: (task) => {
      taskState.tasks = [task, ...taskState.tasks]
      taskState.eventHandlers?.onInvalidation()
    },
    updateTask: (task) => {
      taskState.tasks = taskState.tasks.map((entry) => (entry.id === task.id ? task : entry))
      taskState.eventHandlers?.onInvalidation()
    },
    removeTask: (taskId) => {
      taskState.tasks = taskState.tasks.filter((entry) => entry.id !== taskId)
      taskState.eventHandlers?.onInvalidation()
    },
    listTasksCalls: () => taskState.listCalls,
    listTaskPages: () => taskState.listPageRequests,
    getTaskCalls: () => taskState.getTaskCalls,
    setStreamLive: (live) => taskState.eventHandlers?.onStateChange(live),
    failListReads: (count) => {
      taskState.remainingListFailures += count
    },
    failDetailReads: (taskId, count) => {
      taskState.remainingDetailFailures.set(
        taskId,
        (taskState.remainingDetailFailures.get(taskId) ?? 0) + count
      )
    },
    /** Replaces one task by id in the scripted store without notifying. */
    replaceTaskSilently: (task) => {
      taskState.tasks = taskState.tasks.map((entry) => (entry.id === task.id ? task : entry))
    },
    holdNextListResponse: () => {
      let release: () => void = () => undefined
      taskState.listHolds.push(
        new Promise<void>((resolve) => {
          release = resolve
        })
      )
      taskState.listHoldReleases.push(release)
    },
    releaseHeldListResponses: () => {
      const releases = taskState.listHoldReleases.splice(0)
      taskState.listHolds.splice(0)
      for (const release of releases) release()
    }
  }

  const ports = {
    userId: storyUserId,
    createPublicationSimilar: async () => {
      const result = options.publicationSimilar
      if (!result) return { outcome: 'request-rejected' as const, code: 'not_found' }
      if (!serverSessions.some((session) => session.id === result.session.id)) {
        serverSessions = [result.session, ...serverSessions]
      }
      materials.set(
        result.session.id,
        result.materials.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          fileName: entry.fileName,
          mimeType: entry.mimeType,
          byteSize: entry.byteSize,
          widthPx: entry.widthPx,
          heightPx: entry.heightPx,
          pixelCount:
            entry.kind === 'image' && entry.widthPx !== null && entry.heightPx !== null
              ? entry.widthPx * entry.heightPx
              : null,
          durationMs: entry.durationMs,
          checksumSha256: entry.checksumSha256,
          claimsVersion: entry.claimsVersion,
          createdAt: entry.createdAt
        }))
      )
      return succeeded(result)
    },
    listSessions: async () => succeeded({ sessions: serverSessions, nextCursor: null }),
    createSession: async (name) => {
      createdSessions.push({ name: name ?? '' })
      if (options.createSessionDeferred) await waitForRelease(sessionCreateReleases)
      if (options.createSessionOutcome === 'network-failure') {
        return { outcome: 'network-failure' as const }
      }
      if (options.createSessionOutcome === 'request-rejected') {
        return { outcome: 'request-rejected' as const, code: 'session_limit_reached' }
      }
      const serial = nextCreatedSessionSerial
      nextCreatedSessionSerial += 1
      const created: CreationSessionView = {
        ...sessionB,
        id: `eeeeeeee-0000-4000-8000-${String(serial).padStart(12, '0')}`,
        name: name ?? ''
      }
      serverSessions = [created, ...serverSessions]
      return succeeded(created)
    },
    renameSession: async (sessionId, name) => {
      renameCalls.push({ sessionId, name })
      return succeeded({ ...sessionA, name })
    },
    deleteSession: async (sessionId) => {
      deletedSessionIds.push(sessionId)
      if (options.deleteSessionDeferred) await waitForRelease(sessionDeleteReleases)
      serverSessions = serverSessions.filter((session) => session.id !== sessionId)
      return succeeded(undefined)
    },
    getSessionDetail: async (sessionId) => {
      // Created-at-runtime sessions answer like any other server fact.
      const session = serverSessions.find((entry) => entry.id === sessionId)
      if (!session) return { outcome: 'request-rejected', code: 'not_found' }
      return succeeded({
        id: session.id,
        name: session.name,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      })
    },
    listMaterials: async (sessionId) => {
      materialListCalls += 1
      if (deferNextMaterialList) {
        deferNextMaterialList = false
        await new Promise<void>((resolve) => {
          releaseFirstMaterialList = resolve
        })
      } else if (firstMaterialListDeferred && sessionId === options.deferFirstMaterialListFor) {
        firstMaterialListDeferred = false
        await new Promise<void>((resolve) => {
          releaseFirstMaterialList = resolve
        })
        return succeeded({ materials: [], nextCursor: null })
      }
      return succeeded({ materials: materials.get(sessionId) ?? [], nextCursor: null })
    },
    uploadMaterial: async (sessionId, file, uploadOptions) => {
      uploadCalls.push({ sessionId, name: file.name })
      uploadOptions?.onProgress?.({ sentBytes: Math.ceil(file.size / 2), totalBytes: file.size })
      if (options.uploadDeferred) await waitForRelease(uploadReleases)
      uploadSequence += 1
      const uploaded = material({
        id: `ffffffff-0000-4000-8000-0000000000${String(5 + uploadSequence).padStart(2, '0')}`,
        kind: file.type.startsWith('audio/') ? 'audio' : 'image',
        fileName: file.name
      })
      if (uploaded.kind === 'audio') {
        uploaded.mimeType = file.name.endsWith('.wav')
          ? 'audio/wav'
          : file.name.endsWith('.m4a')
            ? 'audio/mp4'
            : 'audio/mpeg'
      }
      if (
        options.uploadOutcome !== 'network-failure' &&
        options.uploadOutcome !== 'request-rejected'
      ) {
        materials.set(sessionId, [...(materials.get(sessionId) ?? []), uploaded])
      }
      if (
        options.uploadOutcome === 'network-failure' ||
        options.uploadOutcome === 'accepted-response-lost'
      ) {
        return { outcome: 'network-failure' }
      }
      if (options.uploadOutcome === 'request-rejected') {
        return { outcome: 'request-rejected', code: 'material_too_large' }
      }
      return succeeded(uploaded)
    },
    createMaterialFromResult: async (sessionId, input) => {
      resultReuseCalls.push({ sessionId, ...input })
      uploadSequence += 1
      const task = taskState.tasks.find((candidate) => candidate.id === input.taskId)
      const source = task?.slots.find((slot) => slot.index === input.slotIndex)?.result
      const created = material({
        id: `ffffffff-0000-4000-8000-0000000000${String(5 + uploadSequence).padStart(2, '0')}`,
        kind: task?.mediaType ?? 'image',
        fileName: input.fileName
      })
      const withFacts = {
        ...created,
        ...(source
          ? {
              mimeType: source.mimeType,
              byteSize: source.byteSize,
              widthPx: source.widthPx,
              heightPx: source.heightPx,
              pixelCount:
                source.widthPx !== null && source.heightPx !== null
                  ? source.widthPx * source.heightPx
                  : null,
              durationMs: source.durationMs,
              checksumSha256: source.checksumSha256
            }
          : {})
      }
      materials.set(sessionId, [...(materials.get(sessionId) ?? []), withFacts])
      return succeeded(withFacts)
    },
    deleteMaterial: async (materialId) => {
      deletedIds.push(materialId)
      if (options.deleteMaterialDeferred) await waitForRelease(materialDeleteReleases)
      for (const [sessionId, list] of materials) {
        materials.set(
          sessionId,
          list.filter((entry) => entry.id !== materialId)
        )
      }
      return succeeded(undefined)
    },
    loadThumbnailUrl: (materialId) => scriptedMaterialUrl(materialId),
    loadPreviewUrl: (materialId) => scriptedMaterialUrl(materialId),
    loadCapabilityManifest: async () => {
      await manifestReady
      return options.manifestFails || options.manifest === null
        ? { outcome: 'network-failure' }
        : succeeded(options.manifest)
    },
    // Generation task kernel (issue #159): in-memory task store behind the
    // same operations, plus an invalidation handle for SSE scenarios.
    submitTask: async (sessionId, input) => {
      taskState.submitCalls.push({
        sessionId,
        idempotencyKey: input.idempotencyKey,
        intent: input.intent
      })
      if (options.taskScript?.submitDeferred) await waitForRelease(submissionReleases)
      if (options.taskScript?.submitRejection !== undefined) {
        return { outcome: 'request-rejected', code: options.taskScript.submitRejection }
      }
      const existing = taskState.submissionsByKey.get(input.idempotencyKey)
      if (existing !== undefined) return succeeded(detailOf(existing))
      const outcome = submitOutcomes.shift() ?? 'succeeded'
      if (outcome === 'network-failure') return { outcome: 'network-failure' }
      const task: ScriptedTask = {
        id: 'dddddddd-0000-4000-8000-000000000004',
        sessionId,
        status: 'queued',
        mediaType: 'image',
        slotCount: 2,
        snapshot: null,
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
      taskState.submissionsByKey.set(input.idempotencyKey, task)
      if (outcome === 'accepted-response-lost') return { outcome: 'network-failure' }
      return succeeded(detailOf(task))
    },
    listTasks: async (sessionId: string, pageRequest?: TaskListPageRequest) => {
      taskState.listCalls += 1
      taskState.listPageRequests.push({
        sessionId,
        limit: pageRequest?.limit ?? 50,
        cursor: pageRequest?.cursor ?? null
      })
      const holds = taskState.listHolds.splice(0)
      for (const held of holds) await held
      if (taskState.remainingListFailures > 0) {
        taskState.remainingListFailures -= 1
        return { outcome: 'network-failure' as const }
      }
      const all = taskState.tasks
        .filter((task) => task.sessionId === sessionId)
        .sort(tasksNewestFirst)
        .map(
          (task): GenerationTaskView => ({
            id: task.id,
            sessionId: task.sessionId,
            status: task.status,
            mediaType: task.mediaType,
            slotCount: task.slotCount,
            snapshot: task.snapshot ?? null,
            cancelRequested: task.cancelRequested,
            terminalCause: task.terminalCause,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            terminalAt: task.terminalAt
          })
        )
      let start = 0
      if (pageRequest?.cursor) {
        const at = all.findIndex((task) => taskCursorOf(task) === pageRequest.cursor)
        start = at === -1 ? all.length : at + 1
      }
      const limit = pageRequest?.limit ?? 50
      const tasks = all.slice(start, start + limit)
      const nextCursor =
        tasks.length > 0 && start + tasks.length < all.length
          ? taskCursorOf(all[start + tasks.length - 1])
          : null
      return succeeded({ tasks, nextCursor })
    },
    getTask: async (taskId) => {
      await taskDetailsReady
      taskState.getTaskCalls.push(taskId)
      const remaining = taskState.remainingDetailFailures.get(taskId) ?? 0
      if (remaining > 0) {
        taskState.remainingDetailFailures.set(taskId, remaining - 1)
        return { outcome: 'network-failure' as const }
      }
      const task = taskState.tasks.find((entry) => entry.id === taskId)
      if (!task) return { outcome: 'request-rejected', code: 'not_found' }
      return succeeded(detailOf(task))
    },
    cancelTask: async (taskId) => {
      taskState.cancelledIds.push(taskId)
      const task = taskState.tasks.find((entry) => entry.id === taskId)
      if (!task) return { outcome: 'request-rejected', code: 'not_found' }
      return succeeded(detailOf(task))
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
      return succeeded(detailOf(retried))
    },
    // A real blob: URL, never a data: stand-in — a fake would hide any path that
    // fetches the object URL (which the renderer CSP forbids). Transfers are counted
    // so tests can assert how often the data plane moved a slot's bytes.
    loadResultBlob: async (taskId, slotIndex) => {
      resultBlobTransfers.push({ taskId, slotIndex })
      if (options.taskScript?.resultBlobDeferred) {
        await new Promise<void>((resolve) => {
          const release = (): void => {
            resultBlobReleases.delete(release)
            resolve()
          }
          resultBlobReleases.add(release)
        })
      }
      if (remainingResultBlobFailures > 0) {
        remainingResultBlobFailures -= 1
        return { outcome: 'network-failure' }
      }
      return succeeded(resultBlob())
    },
    subscribeEvents: (handlers) => {
      taskState.eventHandlers = handlers
      return () => {
        taskState.eventHandlers = null
      }
    }
  }
  return createCreationRuntime(ports, storyUserId, { storage: localStorage })
}

function Frame({
  children,
  height = 600
}: {
  readonly children: React.ReactNode
  readonly height?: number
}): React.JSX.Element {
  return (
    <I18nextProvider i18n={testI18n}>
      <div style={{ height, display: 'flex' }}>{children}</div>
    </I18nextProvider>
  )
}

interface StoryOptions {
  readonly height?: number
  readonly manifest?: CapabilityManifest | null
  readonly manifestFails?: boolean
  readonly manifestDeferred?: boolean
  readonly drafts?: Readonly<Record<string, LocalDraftRecord | null>>
  readonly materials?: Readonly<Record<string, readonly ReferenceMaterialView[]>>
  readonly materialUrlFailures?: number
  readonly materialUrlDeferred?: boolean
  readonly materialImageUrl?: string
  readonly materialImageUrls?: readonly string[]
  readonly deleteMaterialDeferred?: boolean
  readonly deleteSessionDeferred?: boolean
  readonly uploadDeferred?: boolean
  readonly uploadOutcome?:
    | 'succeeded'
    | 'network-failure'
    | 'accepted-response-lost'
    | 'request-rejected'
  readonly deferFirstMaterialListFor?: string
  readonly createSessionDeferred?: boolean
  readonly createSessionOutcome?: 'network-failure' | 'request-rejected'
  readonly sessions?: readonly CreationSessionView[]
  readonly taskScript?: TaskScript
  readonly publicationSimilar?: PublicationSimilarResult
}

function resolvedRuntimeOptions(options: StoryOptions): RuntimeOptions {
  return {
    manifest: options.manifest === undefined ? activeManifest : options.manifest,
    manifestFails: options.manifestFails,
    manifestDeferred: options.manifestDeferred,
    sessions: options.sessions ?? [sessionA, sessionB],
    taskScript: options.taskScript,
    publicationSimilar: options.publicationSimilar,
    materialUrlFailures: options.materialUrlFailures,
    materialUrlDeferred: options.materialUrlDeferred,
    materialImageUrl: options.materialImageUrl,
    materialImageUrls: options.materialImageUrls,
    deleteMaterialDeferred: options.deleteMaterialDeferred,
    deleteSessionDeferred: options.deleteSessionDeferred,
    uploadDeferred: options.uploadDeferred,
    uploadOutcome: options.uploadOutcome,
    deferFirstMaterialListFor: options.deferFirstMaterialListFor,
    createSessionDeferred: options.createSessionDeferred,
    createSessionOutcome: options.createSessionOutcome,
    drafts: options.drafts ?? {
      [sessionA.id]: {
        prompt: '夏季跑鞋主图，暖光背景',
        promptDocument: {
          version: 1,
          nodes: [{ type: 'text', text: '夏季跑鞋主图，暖光背景' }]
        },
        mediaType: 'image',
        manifestVersion: 5,
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
  }
}

export function RuntimeWorkbenchScope({
  options,
  children
}: {
  readonly options: StoryOptions
  readonly children: React.ReactNode
}): React.JSX.Element {
  const [runtime] = useState(() => installWorkbenchRuntime(resolvedRuntimeOptions(options)))
  const [ready, setReady] = useState(options.publicationSimilar === undefined)
  useEffect(() => {
    if (!options.publicationSimilar) return
    let active = true
    void runtime.actions.preparePublicationSimilar('publication-story').then(() => {
      if (active) setReady(true)
    })
    return () => {
      active = false
    }
  }, [options.publicationSimilar, runtime])
  if (!ready) return <p role="status">Preparing Publication reuse</p>
  return (
    <CreationRuntimeContext.Provider value={runtime}>
      <CreationSessionNavigationProvider>{children}</CreationSessionNavigationProvider>
    </CreationRuntimeContext.Provider>
  )
}

function StorySidebar({
  onOpenCreation = () => undefined
}: {
  readonly onOpenCreation?: () => void
}): React.JSX.Element {
  return (
    <aside className="flex w-52 shrink-0 flex-col">
      <CreationSessionNavigationSidebar onOpenCreation={onOpenCreation} />
    </aside>
  )
}

function WorkbenchWithNavigation(): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={0}>
      <SidebarProvider className="min-h-0 flex-1">
        <StorySidebar />
        <CreationWorkbenchPage />
      </SidebarProvider>
    </TooltipProvider>
  )
}

function RuntimeWorkbenchPage({ options }: { readonly options: StoryOptions }): React.JSX.Element {
  return (
    <RuntimeWorkbenchScope options={options}>
      <CreationWorkbenchPage />
    </RuntimeWorkbenchScope>
  )
}

/** The standard story: an active manifest and one session holding materials. */
export function CreationWorkbenchStory(options: StoryOptions = {}): React.JSX.Element {
  return (
    <Frame height={options.height}>
      <RuntimeWorkbenchScope options={options}>
        <WorkbenchWithNavigation />
      </RuntimeWorkbenchScope>
    </Frame>
  )
}

/** Route-unmount story: the runtime remains above the switched surface just
 * like App.tsx, while the Workbench hook and all display owners are destroyed. */
export function CreationWorkbenchNavigationStory(options: StoryOptions = {}): React.JSX.Element {
  return (
    <I18nextProvider i18n={testI18n}>
      <RuntimeWorkbenchScope options={options}>
        <NavigationStorySurface />
      </RuntimeWorkbenchScope>
    </I18nextProvider>
  )
}

function NavigationStorySurface(): React.JSX.Element {
  const [creationVisible, setCreationVisible] = useState(true)
  return (
    <TooltipProvider delayDuration={0}>
      <SidebarProvider className="min-h-0 flex-1">
        <StorySidebar onOpenCreation={() => setCreationVisible(true)} />
        <div style={{ height: 600 }} className="flex min-w-0 flex-1 flex-col">
          <nav className="flex shrink-0 gap-2 border-b p-2">
            <button type="button" onClick={() => setCreationVisible(false)}>
              Open settings
            </button>
            <button type="button" onClick={() => setCreationVisible(true)}>
              Back to creation
            </button>
          </nav>
          <div className="flex min-h-0 flex-1">
            {creationVisible ? (
              <CreationWorkbenchPage />
            ) : (
              <div data-testid="settings-surface">Settings</div>
            )}
          </div>
        </div>
      </SidebarProvider>
    </TooltipProvider>
  )
}

/** Recreates the route-above provider, matching an application restart. */
export function CreationWorkbenchRestartStory(options: StoryOptions = {}): React.JSX.Element {
  const [run, setRun] = useState(0)
  return (
    <I18nextProvider i18n={testI18n}>
      <button type="button" onClick={() => setRun((current) => current + 1)}>
        Restart app
      </button>
      <RuntimeWorkbenchScope key={run} options={options}>
        <NavigationStorySurface />
      </RuntimeWorkbenchScope>
    </I18nextProvider>
  )
}

/**
 * Layout-contract story: the real page mounted as the App Shell composes it — direct
 * child of the shell's flex-col content container — to pin that the workbench fills the
 * shell area. The real CreationPage is not CT-mountable (auth/connection providers).
 */
export function CreationWorkbenchShellStory(options: StoryOptions = {}): React.JSX.Element {
  return (
    <I18nextProvider i18n={testI18n}>
      <div style={{ height: 600 }} className="flex w-full flex-col">
        <RuntimeWorkbenchScope options={options}>
          <TooltipProvider delayDuration={0}>
            <SidebarProvider className="min-h-0 flex-1">
              <StorySidebar />
              <div className="flex flex-1 flex-col overflow-auto" data-testid="shell-content">
                <CreationWorkbenchPage />
              </div>
            </SidebarProvider>
          </TooltipProvider>
        </RuntimeWorkbenchScope>
      </div>
    </I18nextProvider>
  )
}

export { RuntimeWorkbenchPage }

export type { StoryOptions }
