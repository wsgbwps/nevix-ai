import { useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { testI18n } from './creation-workbench-i18n'
import {
  CreationRuntimeContext,
  CreationWorkbenchPage,
  createCreationRuntime,
  type CreationRuntime
} from '../../../src/renderer/src/features/creation'
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
  GenerationTaskView
} from '../../../src/renderer/src/features/creation/api/generation-task-http'
import {
  readLocalDraft,
  removeLocalDraft,
  writeLocalDraft
} from '../../../src/renderer/src/features/creation/model/draft-store'

/**
 * Black-box composition for the Creation Workbench public surface (issues
 * #156 / #177): the exported page mounted with scripted in-memory ports —
 * including the session draft store and the Capability Manifest. Tests drive
 * visible UI and observe caller-visible port calls; no internal store or hook
 * is exposed beyond a narrow assertion handle.
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
 * Real vendor pixel sizes (豆包生图 OpenAPI x-size-map) for the ratios the
 * tests exercise, so the composer's size row reads exactly what the server
 * publishes for the same selection.
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
  /** Reads this device's local draft record for one session key ('new' for composing). */
  draftRecord(key: string): LocalDraftRecord | null
  deleteMaterialCalls(): string[]
  materialBlobCalls(): ReadonlyArray<{ materialId: string; aborted: boolean }>
  resultBlobTransfers(): ReadonlyArray<{ taskId: string; slotIndex: number }>
  releaseMaterialBlobs(): void
  releaseResultBlobs(): void
  releaseMaterialDeletes(): void
  releaseSessionDeletes(): void
  deferNextMaterialList(): void
  materialListCalls(): number
  uploadCalls(): ReadonlyArray<{ sessionId: string; name: string }>
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
  /** How many task-list reads crossed the data plane. */
  listTasksCalls(): number
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
  /** Number of initial full-preview loads that should fail with no Blob. */
  readonly materialBlobFailures?: number
  /** Keeps full-preview loads pending until the test releases or aborts them. */
  readonly materialBlobDeferred?: boolean
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
  const materialBlobCalls: Array<{ materialId: string; aborted: boolean }> = []
  const materialBlobReleases = new Set<() => void>()
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
  let remainingMaterialBlobFailures = options.materialBlobFailures ?? 0
  const uploadCalls: Array<{ sessionId: string; name: string }> = []
  const createdSessions: Array<{ name: string }> = []
  const renameCalls: Array<{ sessionId: string; name: string }> = []
  const deletedSessionIds: string[] = []
  const resultBlobTransfers: Array<{ taskId: string; slotIndex: number }> = []
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

  window.__creationDeckTest = {
    draftRecord: (key) => readLocalDraft(localStorage, storyUserId, key),
    deleteMaterialCalls: () => deletedIds,
    materialBlobCalls: () => materialBlobCalls,
    resultBlobTransfers: () => resultBlobTransfers,
    releaseMaterialBlobs: () => {
      for (const release of materialBlobReleases) release()
      materialBlobReleases.clear()
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
    listTasksCalls: () => taskState.listCalls,
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
    uploadMaterial: async (sessionId, file) => {
      uploadCalls.push({ sessionId, name: file.name })
      if (options.uploadDeferred) await waitForRelease(uploadReleases)
      const uploaded = material({
        id: 'ffffffff-0000-4000-8000-000000000006',
        kind: 'image',
        fileName: file.name
      })
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
    loadMaterialBlob: async (materialId, signal) => {
      const call = { materialId, aborted: false }
      materialBlobCalls.push(call)
      signal?.addEventListener('abort', () => {
        call.aborted = true
      })
      if (options.materialBlobDeferred) {
        await new Promise<void>((resolve) => {
          const release = (): void => {
            materialBlobReleases.delete(release)
            resolve()
          }
          materialBlobReleases.add(release)
          signal?.addEventListener('abort', release, { once: true })
        })
      }
      if (signal?.aborted) return { outcome: 'network-failure' }
      if (remainingMaterialBlobFailures > 0) {
        remainingMaterialBlobFailures -= 1
        return { outcome: 'network-failure' }
      }
      return succeeded(
        new Blob(
          [
            '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="64"><rect width="100%" height="100%" fill="#88f"/></svg>'
          ],
          { type: 'image/svg+xml' }
        )
      )
    },
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
    listTasks: async (sessionId) => {
      taskState.listCalls += 1
      const holds = taskState.listHolds.splice(0)
      for (const held of holds) await held
      if (taskState.remainingListFailures > 0) {
        taskState.remainingListFailures -= 1
        return { outcome: 'network-failure' as const }
      }
      return succeeded({
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
      })
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
    // A real blob: URL, never a data: stand-in — a fake would hide any
    // path that fetches the object URL (which the renderer CSP forbids).
    // Transfers are counted so tests can assert how often the data plane
    // actually moved a slot's bytes.
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
  readonly drafts?: Readonly<Record<string, LocalDraftRecord | null>>
  readonly materials?: Readonly<Record<string, readonly ReferenceMaterialView[]>>
  readonly materialBlobFailures?: number
  readonly materialBlobDeferred?: boolean
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
}

function resolvedRuntimeOptions(options: StoryOptions): RuntimeOptions {
  return {
    manifest: options.manifest === undefined ? activeManifest : options.manifest,
    manifestFails: options.manifestFails,
    manifestDeferred: options.manifestDeferred,
    sessions: options.sessions ?? [sessionA, sessionB],
    taskScript: options.taskScript,
    materialBlobFailures: options.materialBlobFailures,
    materialBlobDeferred: options.materialBlobDeferred,
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

function RuntimeWorkbenchPage({ options }: { readonly options: StoryOptions }): React.JSX.Element {
  const [runtime] = useState(() => installWorkbenchRuntime(resolvedRuntimeOptions(options)))
  return (
    <CreationRuntimeContext.Provider value={runtime}>
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

/** Route-unmount story: the runtime remains above the switched surface just
 * like App.tsx, while the Workbench hook and all display owners are destroyed. */
export function CreationWorkbenchNavigationStory(options: StoryOptions = {}): React.JSX.Element {
  const [runtime] = useState(() => installWorkbenchRuntime(resolvedRuntimeOptions(options)))
  const [creationVisible, setCreationVisible] = useState(true)
  return (
    <I18nextProvider i18n={testI18n}>
      <CreationRuntimeContext.Provider value={runtime}>
        <div style={{ height: 600 }} className="flex w-full flex-col">
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
      </CreationRuntimeContext.Provider>
    </I18nextProvider>
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

export { RuntimeWorkbenchPage }

export type { StoryOptions }
