import type {
  CreationApiResult,
  CreationSessionView,
  DraftReferenceRole,
  DraftReferenceView,
  ReferenceMaterialView
} from '../api/go-creation-http'
import type { GenerationIntent, TaskSubmitInput } from '../api/generation-task-http'
import {
  listPendingLocalDraftKeys,
  moveLocalDraft,
  remapLocalDraftMaterial,
  removeLocalDraft,
  removeLocalDraftMaterial,
  replaceLocalDraftMaterial,
  setLocalDraftOperationNotice,
  type LocalDraftOperationNotice
} from './draft-store'
import {
  listReferenceMaterialUploadRecoveries,
  putReferenceMaterialUploadRecovery,
  removeReferenceMaterialUploadRecovery
} from './reference-material-upload-recovery'
import {
  listReferenceMaterialDeleteRecoveries,
  putReferenceMaterialDeleteRecovery,
  removeReferenceMaterialDeleteRecovery,
  type ReferenceMaterialDeleteRecovery
} from './reference-material-delete-recovery'
import type { CreationWorkspacePorts } from './ports'
import type { CreationReferenceMaterialUploadRecovery } from '../../../../../shared/ipc/creation/types'

export type WorkbenchActionState =
  | { readonly status: 'idle' }
  | { readonly status: 'preparing' | 'submitting' }
  | { readonly status: 'session-unconfirmed' }
  | { readonly status: 'submission-unconfirmed' | 'material-unconfirmed' }
  | { readonly status: 'failed'; readonly code: string }
  | { readonly status: 'retired' }

export type WorkbenchActionResult = 'accepted' | 'unconfirmed' | 'failed' | 'busy' | 'retired'

export type CreationRuntimeEvent =
  | { readonly type: 'changed'; readonly sessionId: string }
  | { readonly type: 'reconcile'; readonly sessionId: string }
  | { readonly type: 'sessions-reconcile'; readonly sessionId: string }
  | {
      readonly type: 'material-progress'
      readonly sessionId: string
      readonly localId: string
      readonly sentBytes: number
      readonly totalBytes: number
    }
  /** A pending draft's session materialized: its chain rekeyed onto the real
   * session identity and its local draft record moved onto the session key. */
  | {
      readonly type: 'materialized'
      readonly pendingKey: string
      readonly session: CreationSessionView
    }

export interface WorkbenchActions {
  readonly snapshot: (sessionId: string) => WorkbenchActionState
  readonly subscribe: (listener: (event: CreationRuntimeEvent) => void) => () => void
  readonly stagedMaterials: (sessionId: string) => readonly StagedMaterialFile[]
  readonly recoveryMaterials: (sessionId: string) => readonly ReferenceMaterialView[]
  readonly beginMaterialsObservation: (sessionId: string) => number
  readonly observeMaterials: (
    sessionId: string,
    materialIds: readonly string[],
    observation: number
  ) => void
  readonly canReselectMaterial: (sessionId: string, materialId: string) => boolean
  readonly resolvedMaterialId: (sessionId: string, localId: string) => string | null
  readonly stageMaterial: (
    sessionId: string,
    localId: string,
    file: File
  ) => Promise<CreationApiResult<ReferenceMaterialView>>
  readonly replaceMaterial: (
    sessionId: string,
    previousMaterialId: string,
    localId: string,
    file: File,
    role: DraftReferenceRole
  ) => Promise<CreationApiResult<ReferenceMaterialView>>
  readonly submit: (sessionId: string, intent: GenerationIntent) => Promise<WorkbenchActionResult>
  /** No-identity chain: materialize a session under `key`'s pending
   * ownership, upload `files` in the given order, submit the frozen intent;
   * rekeys onto the created session. The synchronous prefix (guard, chain,
   * held files) completes before the first await. */
  readonly submitNewDraft: (
    key: string,
    intent: GenerationIntent,
    files: readonly StagedMaterialFile[]
  ) => Promise<WorkbenchActionResult>
  /** Temporary session-list entries, persisted ones included. */
  readonly pendingDrafts: () => readonly string[]
  readonly resumeSubmission: (sessionId: string) => Promise<WorkbenchActionResult>
  readonly recoverMaterialUploads: () => Promise<void>
  readonly acknowledgeFailure: (sessionId: string) => void
  readonly stopTracking: (sessionId: string) => void
  readonly deleteMaterial: (
    sessionId: string,
    materialId: string
  ) => Promise<CreationApiResult<void>>
  readonly deleteSession: (sessionId: string) => Promise<CreationApiResult<void>>
}

export interface StagedMaterialFile {
  readonly localId: string
  readonly file: File
}

export type CreationRuntime = CreationWorkspacePorts & {
  readonly userId: string
  readonly actions: WorkbenchActions
  readonly retire: () => void
}

interface RuntimeOptions {
  readonly createId?: () => string
  readonly storage?: Storage
  readonly recoveryScope?: string
}

interface PendingMaterial {
  readonly generation: number
  readonly sessionId: string
  readonly fileName: string
  readonly file: File | null
  readonly wirePromise: Promise<CreationApiResult<ReferenceMaterialView>>
  readonly promise: Promise<CreationApiResult<ReferenceMaterialView>>
  readonly controller: AbortController
  state: 'uploading' | 'unconfirmed' | 'succeeded'
}

interface SubmissionChain {
  readonly generation: number
  readonly frozenIntent: GenerationIntent
  readonly idempotencyKey: string
  input?: TaskSubmitInput
  state: WorkbenchActionState
  /** Chain-owned until the session materializes: navigation cannot lose
   * them and nothing uploads before the identity exists. */
  heldFiles: StagedMaterialFile[]
  /** True while a session-creation request may be in flight (ambiguous write). */
  sessionCreationSent: boolean
}

interface DeferredMaterialDelete {
  readonly materialId: string
  readonly execute: (sessionId: string, materialId: string) => Promise<CreationApiResult<void>>
  readonly resolve: (result: CreationApiResult<void>) => void
}

interface DeferredSessionDelete {
  readonly resolve: (result: CreationApiResult<void>) => void
}

type ReferenceResolution =
  | { readonly status: 'ok'; readonly references: DraftReferenceView[] }
  | { readonly status: 'unconfirmed' | 'failed' | 'retired' }

const idleState: WorkbenchActionState = { status: 'idle' }

export function createCreationRuntime(
  ports: CreationWorkspacePorts,
  userId: string,
  options: RuntimeOptions = {}
): CreationRuntime {
  const createId = options.createId ?? (() => crypto.randomUUID())
  const storage =
    options.storage ?? (typeof globalThis.localStorage === 'undefined' ? undefined : localStorage)
  const recoveryScope = options.recoveryScope ?? 'default'
  const listeners = new Set<(event: CreationRuntimeEvent) => void>()
  const materialGenerations = new Map<string, number>()
  const pendingMaterials = new Map<string, PendingMaterial>()
  const resolvedMaterialIds = new Map<string, string>()
  const ambiguousMaterials = new Map<string, string>()
  const recoveryPending = new Map<string, CreationReferenceMaterialUploadRecovery>()
  const recoveredMaterials = new Map<string, ReferenceMaterialView>()
  const recoveredMaterialObservationFloors = new Map<string, number>()
  const materialObservationEpochs = new Map<string, number>()
  const recoveryControllers = new Map<string, AbortController>()
  const recoveryDeleting = new Set<string>()
  const reselectionAllowed = new Set<string>()
  const materialDeletePending = new Map<string, ReferenceMaterialDeleteRecovery>()
  const materialDeleteRuns = new Map<string, Promise<CreationApiResult<void>>>()
  const chains = new Map<string, SubmissionChain>()
  const settledStates = new Map<string, WorkbenchActionState>()
  // Entries persisted by an earlier authenticated use period survive a reload.
  const pendingDraftKeys = new Set<string>(
    storage === undefined ? [] : listPendingLocalDraftKeys(storage, userId)
  )
  const materialFailures = new Map<
    string,
    Extract<WorkbenchActionState, { readonly status: 'failed' }>
  >()
  const deferredMaterialDeletes = new Map<string, DeferredMaterialDelete[]>()
  const deferredSessionDeletes = new Map<string, DeferredSessionDelete[]>()
  const eventSubscriptions = new Set<() => void>()
  let generation = 0
  let retired = false
  let recoveryRun: Promise<void> | null = null

  const materialKey = (sessionId: string, localId: string): string => `${sessionId}:${localId}`
  const clearRecoveredMaterial = (key: string): void => {
    recoveredMaterials.delete(key)
    recoveredMaterialObservationFloors.delete(key)
  }
  const recordRecoveredMaterial = (
    key: string,
    sessionId: string,
    material: ReferenceMaterialView
  ): void => {
    recoveredMaterials.set(key, material)
    recoveredMaterialObservationFloors.set(key, (materialObservationEpochs.get(sessionId) ?? 0) + 1)
  }
  const canReselectMaterial = (sessionId: string, materialId: string): boolean => {
    const key = materialKey(sessionId, materialId)
    return (
      recoveryPending.has(key) &&
      reselectionAllowed.has(key) &&
      !pendingMaterials.has(key) &&
      !recoveryControllers.has(key) &&
      !recoveryDeleting.has(key)
    )
  }
  if (storage !== undefined) {
    for (const recovery of listReferenceMaterialUploadRecoveries(storage, userId, recoveryScope)) {
      recoveryPending.set(materialKey(recovery.sessionId, recovery.idempotencyKey), recovery)
    }
    for (const recovery of listReferenceMaterialDeleteRecoveries(storage, userId, recoveryScope)) {
      materialDeletePending.set(materialKey(recovery.sessionId, recovery.materialId), recovery)
    }
  }
  const emit = (event: CreationRuntimeEvent): void => {
    for (const listener of listeners) listener(event)
  }
  const changed = (sessionId: string): void => emit({ type: 'changed', sessionId })
  const persistNotice = (sessionId: string, notice: LocalDraftOperationNotice | null): void => {
    if (storage !== undefined) setLocalDraftOperationNotice(storage, userId, sessionId, notice)
  }

  const materialFileNamesFor = (sessionId: string, includeSent: boolean): string[] => {
    const names: string[] = []
    for (const [key, material] of pendingMaterials) {
      if (material.sessionId !== sessionId) continue
      if (ambiguousMaterials.has(key) || (includeSent && material.state === 'uploading')) {
        names.push(material.fileName)
      }
    }
    for (const [key, recovery] of recoveryPending) {
      if (key.startsWith(`${sessionId}:`)) names.push(recovery.fileName)
    }
    return [...new Set(names)]
  }

  const operationNoticeFor = (
    sessionId: string,
    includeSent = false
  ): LocalDraftOperationNotice | null => {
    const chain = chains.get(sessionId)
    const state = chain?.state.status
    const submissionUnconfirmed =
      state === 'submission-unconfirmed' || (includeSent && state === 'submitting')
    // No idempotency contract: an ambiguous creation stays flagged until the
    // creator explicitly stops tracking.
    const sessionUnconfirmed =
      state === 'session-unconfirmed' ||
      (includeSent === true && chain?.sessionCreationSent === true)
    const materialFileNames = materialFileNamesFor(sessionId, includeSent)
    return submissionUnconfirmed || sessionUnconfirmed || materialFileNames.length > 0
      ? { sessionUnconfirmed, submissionUnconfirmed, materialFileNames }
      : null
  }

  const syncNotice = (sessionId: string): void => {
    persistNotice(sessionId, operationNoticeFor(sessionId))
  }

  const materialFailureFor = (
    sessionId: string
  ): Extract<WorkbenchActionState, { readonly status: 'failed' }> | undefined => {
    const prefix = `${sessionId}:`
    let latest: Extract<WorkbenchActionState, { readonly status: 'failed' }> | undefined
    for (const [key, failure] of materialFailures) {
      if (key.startsWith(prefix)) latest = failure
    }
    return latest
  }

  const clearMaterialFailures = (sessionId: string): void => {
    const prefix = `${sessionId}:`
    for (const key of materialFailures.keys()) {
      if (key.startsWith(prefix)) materialFailures.delete(key)
    }
  }

  const retire = (): void => {
    if (retired) return
    const affectedSessions = new Set<string>()
    for (const [sessionId, chain] of chains) {
      if (
        chain.state.status === 'submitting' ||
        chain.state.status === 'submission-unconfirmed' ||
        chain.sessionCreationSent
      ) {
        affectedSessions.add(sessionId)
      }
    }
    for (const material of pendingMaterials.values()) {
      if (material.state !== 'succeeded') affectedSessions.add(material.sessionId)
      material.controller.abort()
    }
    for (const controller of recoveryControllers.values()) controller.abort()
    for (const sessionId of affectedSessions) {
      persistNotice(sessionId, operationNoticeFor(sessionId, true))
    }
    retired = true
    generation += 1
    chains.clear()
    settledStates.clear()
    materialFailures.clear()
    pendingMaterials.clear()
    resolvedMaterialIds.clear()
    ambiguousMaterials.clear()
    recoveryPending.clear()
    recoveredMaterials.clear()
    recoveredMaterialObservationFloors.clear()
    materialObservationEpochs.clear()
    recoveryControllers.clear()
    recoveryDeleting.clear()
    reselectionAllowed.clear()
    materialDeletePending.clear()
    materialDeleteRuns.clear()
    for (const unsubscribe of eventSubscriptions) {
      try {
        unsubscribe()
      } catch {
        // Retirement is fail-closed even if an adapter cleanup misbehaves.
      }
    }
    eventSubscriptions.clear()
    for (const deletes of deferredMaterialDeletes.values()) {
      for (const deletion of deletes) deletion.resolve({ outcome: 'unauthorized' })
    }
    for (const deletes of deferredSessionDeletes.values()) {
      for (const deletion of deletes) deletion.resolve({ outcome: 'unauthorized' })
    }
    deferredMaterialDeletes.clear()
    deferredSessionDeletes.clear()
    for (const listener of listeners) listener({ type: 'changed', sessionId: '' })
  }

  const normalizeFailure = <T>(result: CreationApiResult<T>): CreationApiResult<T> => {
    if (result.outcome === 'unauthorized') retire()
    return result
  }

  const guardResult =
    <Args extends unknown[], Value>(
      operation: (...args: Args) => Promise<CreationApiResult<Value>>
    ): ((...args: Args) => Promise<CreationApiResult<Value>>) =>
    async (...args) => {
      if (retired) return { outcome: 'unauthorized' }
      const result = await operation(...args)
      return retired ? { outcome: 'unauthorized' } : normalizeFailure(result)
    }

  // A 401 on any Creation fact or command confirms that this authenticated
  // use period is over. Retire every old action, even when the confirming
  // response came from a display read rather than the action itself.
  const guardedPorts: CreationWorkspacePorts = {
    ...ports,
    listSessions: guardResult(ports.listSessions),
    createSession: guardResult(ports.createSession),
    renameSession: guardResult(ports.renameSession),
    deleteSession: guardResult(ports.deleteSession),
    getSessionDetail: guardResult(ports.getSessionDetail),
    listMaterials: guardResult(ports.listMaterials),
    uploadMaterial: guardResult(ports.uploadMaterial),
    recoverMaterialUpload: guardResult(ports.recoverMaterialUpload),
    abortMaterialUpload: guardResult(ports.abortMaterialUpload),
    createMaterialFromResult: guardResult(ports.createMaterialFromResult),
    deleteMaterial: guardResult(ports.deleteMaterial),
    loadCapabilityManifest: guardResult(ports.loadCapabilityManifest),
    submitTask: guardResult(ports.submitTask),
    listTasks: guardResult(ports.listTasks),
    getTask: guardResult(ports.getTask),
    cancelTask: guardResult(ports.cancelTask),
    retryTask: guardResult(ports.retryTask),
    loadMaterialBlob: guardResult(ports.loadMaterialBlob),
    loadResultBlob: guardResult(ports.loadResultBlob),
    subscribeEvents: (handlers) => {
      if (retired) return () => undefined
      let active = true
      let unsubscribe = (): void => undefined
      const release = (): void => {
        if (!active) return
        active = false
        eventSubscriptions.delete(release)
        unsubscribe()
      }
      unsubscribe = ports.subscribeEvents({
        ...handlers,
        onUnauthorized: () => {
          if (!active) return
          retire()
          handlers.onUnauthorized()
        }
      })
      if (retired) {
        release()
        return () => undefined
      }
      eventSubscriptions.add(release)
      return release
    }
  }

  const stageMaterialFor = (
    sessionId: string,
    localId: string,
    file: File,
    reconcileOnSuccess: boolean
  ): Promise<CreationApiResult<ReferenceMaterialView>> => {
    if (retired) return Promise.resolve({ outcome: 'unauthorized' })
    const key = materialKey(sessionId, localId)
    const existing = pendingMaterials.get(key)
    if (existing !== undefined) return existing.promise
    materialFailures.delete(key)

    const materialGeneration = ++generation
    materialGenerations.set(key, materialGeneration)
    const controller = new AbortController()
    const priorRecovery = recoveryPending.get(key)
    const priorReselectionAllowed = reselectionAllowed.delete(key)
    clearRecoveredMaterial(key)
    const provisionalRecovery: CreationReferenceMaterialUploadRecovery = {
      idempotencyKey: localId,
      sessionId,
      fileName: file.name,
      declaredKind: materialKindFor(file.type),
      declaredMimeType: file.type,
      declaredByteSize: file.size
    }
    recoveryPending.set(key, provisionalRecovery)
    if (storage !== undefined) {
      putReferenceMaterialUploadRecovery(storage, userId, recoveryScope, provisionalRecovery)
    }
    let leaseObserved = false
    const settlePreLeaseRecovery = (): void => {
      if (leaseObserved) return
      if (priorRecovery !== undefined) {
        recoveryPending.set(key, priorRecovery)
        if (priorReselectionAllowed) reselectionAllowed.add(key)
        if (storage !== undefined) {
          putReferenceMaterialUploadRecovery(storage, userId, recoveryScope, priorRecovery)
        }
        return
      }
      recoveryPending.delete(key)
      if (storage !== undefined) {
        removeReferenceMaterialUploadRecovery(storage, userId, recoveryScope, localId)
      }
    }
    const wirePromise = ports
      .uploadMaterial(sessionId, file, {
        signal: controller.signal,
        idempotencyKey: localId,
        onLease: (recovery) => {
          if (
            retired ||
            materialGenerations.get(key) !== materialGeneration ||
            recoveryDeleting.has(key)
          ) {
            return
          }
          leaseObserved = true
          recoveryPending.set(key, recovery)
          if (storage !== undefined) {
            putReferenceMaterialUploadRecovery(storage, userId, recoveryScope, recovery)
          }
        },
        onProgress: ({ sentBytes, totalBytes }) => {
          if (materialGenerations.get(key) !== materialGeneration || retired) return
          emit({
            type: 'material-progress',
            sessionId,
            localId,
            sentBytes,
            totalBytes
          })
        }
      })
      .catch((): CreationApiResult<ReferenceMaterialView> => ({ outcome: 'network-failure' }))
    const promise = wirePromise.then((result) => {
      if (result.outcome === 'unauthorized') {
        if (materialGenerations.get(key) === materialGeneration) {
          materialGenerations.delete(key)
          pendingMaterials.delete(key)
          ambiguousMaterials.delete(key)
          settlePreLeaseRecovery()
        }
        normalizeFailure(result)
        return result
      }
      if (retired) return { outcome: 'unauthorized' } as const
      if (materialGenerations.get(key) !== materialGeneration) {
        return { outcome: 'request-rejected', code: 'action-retired' } as const
      }
      if (result.outcome === 'succeeded') {
        resolvedMaterialIds.set(key, result.value.id)
        ambiguousMaterials.delete(key)
        recoveryPending.delete(key)
        reselectionAllowed.delete(key)
        const completed = pendingMaterials.get(key)
        if (completed !== undefined) {
          // The Go material identity now carries the action; release the
          // potentially large File while retaining the settled Promise for
          // identity deduplication and delayed deletion.
          pendingMaterials.set(key, { ...completed, file: null, state: 'succeeded' })
        }
        if (storage !== undefined) {
          remapLocalDraftMaterial(storage, userId, sessionId, localId, result.value.id)
          removeReferenceMaterialUploadRecovery(storage, userId, recoveryScope, localId)
        }
        materialFailures.delete(key)
        syncNotice(sessionId)
        if (reconcileOnSuccess) emit({ type: 'reconcile', sessionId })
      } else if (result.outcome === 'network-failure') {
        if (priorRecovery !== undefined && !leaseObserved) settlePreLeaseRecovery()
        const pending = pendingMaterials.get(key)
        if (pending !== undefined) pending.state = 'unconfirmed'
        ambiguousMaterials.set(key, file.name)
        syncNotice(sessionId)
        changed(sessionId)
      } else if (result.outcome === 'request-rejected' && result.code === 'upload_cancelled') {
        materialGenerations.delete(key)
        pendingMaterials.delete(key)
        ambiguousMaterials.delete(key)
        recoveryPending.delete(key)
        reselectionAllowed.delete(key)
        if (storage !== undefined) {
          removeReferenceMaterialUploadRecovery(storage, userId, recoveryScope, localId)
        }
        syncNotice(sessionId)
        changed(sessionId)
      } else if (result.outcome === 'request-rejected' && result.code === 'upload_terminal') {
        materialGenerations.delete(key)
        pendingMaterials.delete(key)
        ambiguousMaterials.delete(key)
        recoveryPending.delete(key)
        clearRecoveredMaterial(key)
        reselectionAllowed.delete(key)
        if (storage !== undefined) {
          removeReferenceMaterialUploadRecovery(storage, userId, recoveryScope, localId)
          removeLocalDraftMaterial(storage, userId, sessionId, localId)
        }
        materialFailures.set(key, { status: 'failed', code: 'upload_requires_new_key' })
        syncNotice(sessionId)
        changed(sessionId)
        emit({ type: 'reconcile', sessionId })
      } else if (
        result.outcome === 'request-rejected' &&
        result.code === 'upload_requires_reselection'
      ) {
        materialGenerations.delete(key)
        pendingMaterials.delete(key)
        ambiguousMaterials.delete(key)
        reselectionAllowed.add(key)
        materialFailures.set(key, { status: 'failed', code: result.code })
        syncNotice(sessionId)
        changed(sessionId)
      } else {
        materialGenerations.delete(key)
        pendingMaterials.delete(key)
        ambiguousMaterials.delete(key)
        settlePreLeaseRecovery()
        materialFailures.set(key, {
          status: 'failed',
          code: result.outcome === 'request-rejected' ? result.code : result.outcome
        })
        syncNotice(sessionId)
        changed(sessionId)
        emit({ type: 'reconcile', sessionId })
      }
      return result
    })
    pendingMaterials.set(key, {
      generation: materialGeneration,
      sessionId,
      fileName: file.name,
      file,
      wirePromise,
      promise,
      controller,
      state: 'uploading'
    })
    return promise
  }

  const stageMaterial: WorkbenchActions['stageMaterial'] = (sessionId, localId, file) =>
    stageMaterialFor(sessionId, localId, file, true)

  const driveMaterialUploadRecovery = async (): Promise<void> => {
    if (retired || storage === undefined) return
    const recoveries = listReferenceMaterialUploadRecoveries(storage, userId, recoveryScope)
    for (const recovery of recoveries) {
      if (retired) return
      const key = materialKey(recovery.sessionId, recovery.idempotencyKey)
      const currentRecovery = recoveryPending.get(key)
      if (currentRecovery === undefined || recoveryDeleting.has(key)) continue
      const controller = new AbortController()
      recoveryControllers.set(key, controller)
      const result = await guardedPorts
        .recoverMaterialUpload(currentRecovery, controller.signal)
        .catch(() => ({ outcome: 'network-failure' }) as const)
        .finally(() => {
          if (recoveryControllers.get(key) === controller) recoveryControllers.delete(key)
        })
      if (retired) return
      if (recoveryPending.get(key) !== currentRecovery || recoveryDeleting.has(key)) continue
      if (result.outcome === 'succeeded') {
        resolvedMaterialIds.set(key, result.value.id)
        recoveryPending.delete(key)
        recordRecoveredMaterial(key, recovery.sessionId, result.value)
        reselectionAllowed.delete(key)
        remapLocalDraftMaterial(
          storage,
          userId,
          recovery.sessionId,
          recovery.idempotencyKey,
          result.value.id
        )
        removeReferenceMaterialUploadRecovery(
          storage,
          userId,
          recoveryScope,
          recovery.idempotencyKey
        )
        materialFailures.delete(key)
        emit({ type: 'reconcile', sessionId: recovery.sessionId })
        continue
      }
      if (result.outcome === 'request-rejected' && result.code === 'upload_terminal') {
        recoveryPending.delete(key)
        clearRecoveredMaterial(key)
        reselectionAllowed.delete(key)
        removeLocalDraftMaterial(storage, userId, recovery.sessionId, recovery.idempotencyKey)
        removeReferenceMaterialUploadRecovery(
          storage,
          userId,
          recoveryScope,
          recovery.idempotencyKey
        )
        materialFailures.set(key, {
          status: 'failed',
          code: 'upload_requires_new_key'
        })
        emit({ type: 'reconcile', sessionId: recovery.sessionId })
        continue
      }
      if (result.outcome === 'request-rejected' && result.code === 'upload_requires_reselection') {
        materialGenerations.delete(key)
        pendingMaterials.delete(key)
        ambiguousMaterials.delete(key)
        reselectionAllowed.add(key)
      }
      recoveryPending.set(key, currentRecovery)
      syncNotice(recovery.sessionId)
      changed(recovery.sessionId)
    }
  }

  const driveMaterialDeleteRecovery = async (): Promise<void> => {
    for (const recovery of materialDeletePending.values()) {
      if (retired) return
      const result = await runDurableMaterialDelete(recovery.sessionId, recovery.materialId)
      if (!retired && result.outcome === 'succeeded') {
        emit({ type: 'reconcile', sessionId: recovery.sessionId })
      }
    }
  }

  const recoverMaterialUploads = (): Promise<void> => {
    if (recoveryRun !== null) return recoveryRun
    const run = Promise.all([driveMaterialDeleteRecovery(), driveMaterialUploadRecovery()])
      .then(() => undefined)
      .finally(() => {
        if (recoveryRun === run) recoveryRun = null
      })
    recoveryRun = run
    return run
  }

  const currentChain = (sessionId: string, chain: SubmissionChain): boolean =>
    !retired && chains.get(sessionId)?.generation === chain.generation

  const setChainState = (
    sessionId: string,
    chain: SubmissionChain,
    state: WorkbenchActionState
  ): void => {
    if (!currentChain(sessionId, chain)) return
    chain.state = state
    syncNotice(sessionId)
    changed(sessionId)
  }

  const runMaterialDelete = async (materialId: string): Promise<CreationApiResult<void>> => {
    if (retired) return { outcome: 'unauthorized' }
    const result = await ports
      .deleteMaterial(materialId)
      .catch(() => ({ outcome: 'network-failure' }) as const)
    return retired ? { outcome: 'unauthorized' } : normalizeFailure(result)
  }

  const runDurableMaterialDelete = (
    sessionId: string,
    materialId: string
  ): Promise<CreationApiResult<void>> => {
    if (retired) return Promise.resolve({ outcome: 'unauthorized' })
    const key = materialKey(sessionId, materialId)
    const existing = materialDeleteRuns.get(key)
    if (existing !== undefined) return existing
    const recovery = { sessionId, materialId }
    materialDeletePending.set(key, recovery)
    if (storage !== undefined) {
      putReferenceMaterialDeleteRecovery(storage, userId, recoveryScope, recovery)
    }
    const run = runMaterialDelete(materialId)
      .then((result) => {
        if (
          result.outcome === 'succeeded' ||
          (result.outcome === 'request-rejected' && result.code === 'not_found')
        ) {
          materialDeletePending.delete(key)
          if (storage !== undefined) {
            removeReferenceMaterialDeleteRecovery(storage, userId, recoveryScope, materialId)
          }
          return { outcome: 'succeeded', value: undefined } as const
        }
        return result
      })
      .finally(() => {
        if (materialDeleteRuns.get(key) === run) materialDeleteRuns.delete(key)
      })
    materialDeleteRuns.set(key, run)
    return run
  }

  const runMaterialDeleteForSession = async (
    sessionId: string,
    materialId: string
  ): Promise<CreationApiResult<void>> => {
    if (retired) return { outcome: 'unauthorized' }
    const key = materialKey(sessionId, materialId)
    const finishDelete = async (targetId: string): Promise<CreationApiResult<void>> => {
      const result = await runDurableMaterialDelete(sessionId, targetId)
      if (result.outcome === 'succeeded') materialFailures.delete(key)
      return result
    }
    const resolved = resolvedMaterialIds.get(key)
    if (resolved !== undefined) return finishDelete(resolved)
    const pending = pendingMaterials.get(key)
    if (pending === undefined) return finishDelete(materialId)
    // Local tracking may stop while this deletion is queued. The public
    // Promise then retires, but cleanup still needs the raw Go identity so a
    // material that was accepted meanwhile does not become orphaned.
    const result = await pending.wirePromise
    if (retired) return { outcome: 'unauthorized' }
    if (result.outcome === 'unauthorized') return normalizeFailure(result)
    if (result.outcome === 'succeeded') return finishDelete(result.value.id)
    return result
  }

  const runSessionDelete = async (sessionId: string): Promise<CreationApiResult<void>> => {
    if (retired) return { outcome: 'unauthorized' }
    const result = normalizeFailure(
      await ports.deleteSession(sessionId).catch(() => ({ outcome: 'network-failure' }) as const)
    )
    if (result.outcome === 'succeeded' && storage !== undefined) {
      removeLocalDraft(storage, userId, sessionId)
    }
    if (result.outcome === 'succeeded') {
      clearMaterialFailures(sessionId)
      emit({ type: 'sessions-reconcile', sessionId })
    }
    return result
  }

  const flushDeletes = (sessionId: string): void => {
    if (retired || chains.has(sessionId)) return
    const materialDeletes = deferredMaterialDeletes.get(sessionId) ?? []
    deferredMaterialDeletes.delete(sessionId)
    for (const deletion of materialDeletes) {
      void deletion.execute(sessionId, deletion.materialId).then(deletion.resolve)
    }
    const sessionDeletes = deferredSessionDeletes.get(sessionId) ?? []
    deferredSessionDeletes.delete(sessionId)
    for (const deletion of sessionDeletes) {
      void runSessionDelete(sessionId).then(deletion.resolve)
    }
  }

  const finishAccepted = (sessionId: string, chain: SubmissionChain): WorkbenchActionResult => {
    if (!currentChain(sessionId, chain)) return retired ? 'retired' : 'failed'
    chains.delete(sessionId)
    settledStates.delete(sessionId)
    syncNotice(sessionId)
    changed(sessionId)
    emit({ type: 'reconcile', sessionId })
    flushDeletes(sessionId)
    return 'accepted'
  }

  const sendSubmission = async (
    sessionId: string,
    chain: SubmissionChain
  ): Promise<WorkbenchActionResult> => {
    if (!currentChain(sessionId, chain) || chain.input === undefined) return 'retired'
    setChainState(sessionId, chain, { status: 'submitting' })
    const result = await ports
      .submitTask(sessionId, chain.input)
      .catch(() => ({ outcome: 'network-failure' }) as const)
    if (result.outcome === 'unauthorized') {
      if (currentChain(sessionId, chain)) chains.delete(sessionId)
      normalizeFailure(result)
      return 'retired'
    }
    if (!currentChain(sessionId, chain)) return 'retired'
    if (result.outcome === 'succeeded') return finishAccepted(sessionId, chain)
    if (result.outcome === 'network-failure') {
      setChainState(sessionId, chain, { status: 'submission-unconfirmed' })
      return 'unconfirmed'
    }
    chains.delete(sessionId)
    settledStates.set(sessionId, {
      status: 'failed',
      code: result.outcome === 'request-rejected' ? result.code : result.outcome
    })
    syncNotice(sessionId)
    changed(sessionId)
    flushDeletes(sessionId)
    return 'failed'
  }

  const freezeIntent = (intent: GenerationIntent): GenerationIntent => ({
    ...intent,
    references: intent.references.map(
      (reference): DraftReferenceView => ({
        materialId: reference.materialId,
        role: reference.role
      })
    )
  })

  /** Non-success upload verdict → chain state; unauthorized already retired
   * the runtime inside the staging path. */
  const settleStagedMaterial = (
    sessionId: string,
    chain: SubmissionChain,
    result: CreationApiResult<ReferenceMaterialView>
  ): Extract<WorkbenchActionResult, 'unconfirmed' | 'failed' | 'retired'> => {
    if (result.outcome === 'network-failure') {
      setChainState(sessionId, chain, { status: 'material-unconfirmed' })
      return 'unconfirmed'
    }
    if (result.outcome === 'unauthorized') return 'retired'
    const code = result.outcome === 'request-rejected' ? result.code : result.outcome
    setChainState(sessionId, chain, { status: 'failed', code })
    chains.delete(sessionId)
    settledStates.set(sessionId, { status: 'failed', code })
    syncNotice(sessionId)
    changed(sessionId)
    flushDeletes(sessionId)
    return 'failed'
  }

  /** Resolves the frozen references' real Go material identities, preserving
   * order and roles. */
  const resolveReferenceMaterials = async (
    sessionId: string,
    chain: SubmissionChain
  ): Promise<ReferenceResolution> => {
    const references: DraftReferenceView[] = []
    for (const reference of chain.frozenIntent.references) {
      const key = materialKey(sessionId, reference.materialId)
      let materialId = resolvedMaterialIds.get(key)
      const pending = pendingMaterials.get(key)
      if (materialId === undefined && pending !== undefined) {
        const result = await pending.promise
        if (!currentChain(sessionId, chain)) return { status: 'retired' }
        if (result.outcome !== 'succeeded') {
          return { status: settleStagedMaterial(sessionId, chain, result) }
        }
        materialId = result.value.id
      }
      references.push({ ...reference, materialId: materialId ?? reference.materialId })
    }
    if (!currentChain(sessionId, chain)) return { status: 'retired' }
    return { status: 'ok', references }
  }

  const submit: WorkbenchActions['submit'] = async (sessionId, intent) => {
    if (retired) return 'retired'
    const existing = chains.get(sessionId)
    if (
      existing !== undefined &&
      existing.state.status !== 'failed' &&
      existing.state.status !== 'idle'
    ) {
      return 'busy'
    }
    settledStates.delete(sessionId)

    const chain: SubmissionChain = {
      generation: ++generation,
      frozenIntent: freezeIntent(intent),
      idempotencyKey: createId(),
      state: { status: 'preparing' },
      heldFiles: [],
      sessionCreationSent: false
    }
    chains.set(sessionId, chain)
    syncNotice(sessionId)
    changed(sessionId)

    const resolved = await resolveReferenceMaterials(sessionId, chain)
    if (resolved.status !== 'ok') return resolved.status
    chain.input = {
      idempotencyKey: chain.idempotencyKey,
      intent: { ...chain.frozenIntent, references: resolved.references }
    }
    return sendSubmission(sessionId, chain)
  }

  /** Rekeys chain, draft record, list entry, and deferred deletions onto the
   * session identity in one synchronous step — no write can land under the
   * pending key afterwards. Queued deletions still carry local ids, mapped to
   * Go identities at flush time. */
  const materializeChain = (pendingKey: string, session: CreationSessionView): void => {
    const chain = chains.get(pendingKey)
    if (chain === undefined) return
    chains.delete(pendingKey)
    chains.set(session.id, chain)
    const settled = settledStates.get(pendingKey)
    if (settled !== undefined) {
      settledStates.delete(pendingKey)
      settledStates.set(session.id, settled)
    }
    const deferredDeletes = deferredMaterialDeletes.get(pendingKey)
    if (deferredDeletes !== undefined) {
      deferredMaterialDeletes.delete(pendingKey)
      deferredMaterialDeletes.set(session.id, [
        ...(deferredMaterialDeletes.get(session.id) ?? []),
        ...deferredDeletes
      ])
    }
    pendingDraftKeys.delete(pendingKey)
    if (storage !== undefined) {
      moveLocalDraft(storage, userId, pendingKey, session.id)
    }
    emit({ type: 'materialized', pendingKey, session })
  }

  const submitNewDraft: WorkbenchActions['submitNewDraft'] = async (pendingKey, intent, files) => {
    if (retired) return 'retired'
    const existing = chains.get(pendingKey)
    if (
      existing !== undefined &&
      existing.state.status !== 'failed' &&
      existing.state.status !== 'idle'
    ) {
      return 'busy'
    }
    settledStates.delete(pendingKey)

    const chain: SubmissionChain = {
      generation: ++generation,
      frozenIntent: freezeIntent(intent),
      idempotencyKey: createId(),
      state: { status: 'preparing' },
      heldFiles: files.map((held) => ({ localId: held.localId, file: held.file })),
      sessionCreationSent: false
    }
    chains.set(pendingKey, chain)
    pendingDraftKeys.add(pendingKey)
    changed(pendingKey)

    // Record the ambiguous write BEFORE the request leaves (a hard reload
    // keeps the notice); cleared only on a definitive outcome or materialization.
    chain.sessionCreationSent = true
    if (storage !== undefined) {
      setLocalDraftOperationNotice(storage, userId, pendingKey, {
        sessionUnconfirmed: true,
        submissionUnconfirmed: false,
        materialFileNames: []
      })
    }
    const created = await ports
      .createSession('')
      .catch((): CreationApiResult<CreationSessionView> => ({ outcome: 'network-failure' }))
    chain.sessionCreationSent = false
    if (created.outcome === 'unauthorized') {
      if (currentChain(pendingKey, chain)) chains.delete(pendingKey)
      normalizeFailure(created)
      return 'retired'
    }
    if (!currentChain(pendingKey, chain)) return 'retired'
    if (created.outcome === 'network-failure') {
      setChainState(pendingKey, chain, { status: 'session-unconfirmed' })
      return 'unconfirmed'
    }
    if (created.outcome !== 'succeeded') {
      const code = created.outcome === 'request-rejected' ? created.code : created.outcome
      chains.delete(pendingKey)
      settledStates.set(pendingKey, { status: 'failed', code })
      if (storage !== undefined) {
        setLocalDraftOperationNotice(storage, userId, pendingKey, null)
      }
      changed(pendingKey)
      return 'failed'
    }

    const session = created.value
    if (storage !== undefined) {
      setLocalDraftOperationNotice(storage, userId, pendingKey, null)
    }
    materializeChain(pendingKey, session)

    // Sequential in frozen order; each file stays held until it stages so
    // stagedMaterials keeps showing the rest, and a stop between awaits
    // cannot start the next upload.
    while (chain.heldFiles.length > 0) {
      if (!currentChain(session.id, chain)) return 'retired'
      const held = chain.heldFiles.shift()
      if (held === undefined) break
      const result = await stageMaterialFor(session.id, held.localId, held.file, true)
      if (!currentChain(session.id, chain)) return 'retired'
      if (result.outcome !== 'succeeded') {
        return settleStagedMaterial(session.id, chain, result)
      }
    }

    const resolved = await resolveReferenceMaterials(session.id, chain)
    if (resolved.status !== 'ok') return resolved.status
    chain.input = {
      idempotencyKey: chain.idempotencyKey,
      intent: { ...chain.frozenIntent, references: resolved.references }
    }
    return sendSubmission(session.id, chain)
  }

  const requestMaterialDelete = (
    sessionId: string,
    materialId: string,
    execute: (
      sessionId: string,
      materialId: string
    ) => Promise<CreationApiResult<void>> = runMaterialDeleteForSession
  ): Promise<CreationApiResult<void>> => {
    const chain = chains.get(sessionId)
    const retained = chain?.frozenIntent.references.some(
      (reference) =>
        reference.materialId === materialId ||
        resolvedMaterialIds.get(materialKey(sessionId, reference.materialId)) === materialId
    )
    if (!retained) return execute(sessionId, materialId)
    return new Promise((resolve) => {
      const queued = deferredMaterialDeletes.get(sessionId) ?? []
      queued.push({ materialId, execute, resolve })
      deferredMaterialDeletes.set(sessionId, queued)
    })
  }

  const deleteMaterial: WorkbenchActions['deleteMaterial'] = async (sessionId, materialId) => {
    if (retired) return { outcome: 'unauthorized' }
    const key = materialKey(sessionId, materialId)
    const pending = pendingMaterials.get(key)
    pending?.controller.abort()
    const recovery = recoveryPending.get(key)
    if (recovery !== undefined) {
      // Explicit deletion owns this key from here. Fence the active upload's
      // late completion before aborting either IPC operation.
      materialGenerations.delete(key)
      pendingMaterials.delete(key)
      ambiguousMaterials.delete(key)
      materialFailures.delete(key)
      recoveryPending.delete(key)
      reselectionAllowed.delete(key)
      if (storage !== undefined) {
        removeReferenceMaterialUploadRecovery(
          storage,
          userId,
          recoveryScope,
          recovery.idempotencyKey
        )
        removeLocalDraftMaterial(storage, userId, sessionId, recovery.idempotencyKey)
      }
      syncNotice(sessionId)
      recoveryDeleting.add(key)
      recoveryControllers.get(key)?.abort()
      const controller = new AbortController()
      recoveryControllers.set(key, controller)
      const aborted = await guardedPorts
        .abortMaterialUpload(recovery, controller.signal)
        .catch(() => ({ outcome: 'network-failure' }) as const)
        .finally(() => {
          if (recoveryControllers.get(key) === controller) recoveryControllers.delete(key)
        })
      if (retired) return { outcome: 'unauthorized' }
      if (aborted.outcome !== 'succeeded') {
        recoveryDeleting.delete(key)
        clearRecoveredMaterial(key)
        resolvedMaterialIds.delete(key)
        emit({ type: 'reconcile', sessionId })
        return aborted
      }
      if (aborted.value !== null) {
        resolvedMaterialIds.set(key, aborted.value.id)
        recordRecoveredMaterial(key, sessionId, aborted.value)
        const deletion = await runDurableMaterialDelete(sessionId, aborted.value.id)
        if (deletion.outcome !== 'succeeded') {
          recoveryDeleting.delete(key)
          emit({ type: 'reconcile', sessionId })
          return deletion
        }
      }
      recoveryDeleting.delete(key)
      clearRecoveredMaterial(key)
      resolvedMaterialIds.delete(key)
      if (storage !== undefined && aborted.value !== null) {
        removeLocalDraftMaterial(storage, userId, sessionId, aborted.value.id)
      }
      emit({ type: 'reconcile', sessionId })
      return { outcome: 'succeeded', value: undefined }
    }
    const result = await runMaterialDeleteForSession(sessionId, materialId)
    if (result.outcome === 'succeeded') {
      clearRecoveredMaterial(key)
      resolvedMaterialIds.delete(key)
      for (const [recoveryKey, recovered] of recoveredMaterials) {
        if (recoveryKey.startsWith(`${sessionId}:`) && recovered.id === materialId) {
          clearRecoveredMaterial(recoveryKey)
          resolvedMaterialIds.delete(recoveryKey)
        }
      }
    }
    if (!retired) emit({ type: 'reconcile', sessionId })
    return result
  }

  const replaceMaterial: WorkbenchActions['replaceMaterial'] = async (
    sessionId,
    previousMaterialId,
    localId,
    file,
    role
  ) => {
    const key = materialKey(sessionId, localId)
    const previousKey = materialKey(sessionId, previousMaterialId)
    const continuingRecovery =
      previousMaterialId === localId && canReselectMaterial(sessionId, localId)
    if (recoveryPending.has(previousKey) && !continuingRecovery) {
      return { outcome: 'request-rejected', code: 'upload_reselection_not_ready' }
    }
    const result = await stageMaterialFor(sessionId, localId, file, false)
    if (result.outcome !== 'succeeded') return result
    if (retired) return { outcome: 'unauthorized' }
    if (resolvedMaterialIds.get(key) !== result.value.id) {
      return { outcome: 'request-rejected', code: 'action-retired' }
    }
    if (continuingRecovery) {
      emit({ type: 'reconcile', sessionId })
      return result
    }
    if (storage !== undefined) {
      replaceLocalDraftMaterial(
        storage,
        userId,
        sessionId,
        previousMaterialId,
        result.value.id,
        role
      )
    }
    const deletion = await requestMaterialDelete(sessionId, previousMaterialId)
    if (retired || deletion.outcome === 'unauthorized') return { outcome: 'unauthorized' }
    if (resolvedMaterialIds.get(key) !== result.value.id) {
      return { outcome: 'request-rejected', code: 'action-retired' }
    }
    if (storage !== undefined) {
      // The display may have written later prompt/parameter/reference edits
      // while DELETE was pending. Reapply only the identity replacement to
      // that newest record so the action cannot overwrite those edits.
      replaceLocalDraftMaterial(
        storage,
        userId,
        sessionId,
        previousMaterialId,
        result.value.id,
        role
      )
    }
    emit({ type: 'reconcile', sessionId })
    return result
  }

  const actions: WorkbenchActions = {
    snapshot: (sessionId) =>
      retired
        ? { status: 'retired' }
        : (chains.get(sessionId)?.state ??
          settledStates.get(sessionId) ??
          materialFailureFor(sessionId) ??
          (materialFileNamesFor(sessionId, false).length > 0
            ? { status: 'material-unconfirmed' }
            : idleState)),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stagedMaterials: (sessionId) => {
      if (retired) return []
      const prefix = `${sessionId}:`
      const staged: StagedMaterialFile[] = []
      for (const [key, material] of pendingMaterials) {
        if (
          !key.startsWith(prefix) ||
          resolvedMaterialIds.has(key) ||
          materialGenerations.get(key) !== material.generation ||
          material.file === null
        ) {
          continue
        }
        staged.push({ localId: key.slice(prefix.length), file: material.file })
      }
      // A pre-materialization chain holds its files itself; the display
      // re-registers them from here exactly like staged uploads.
      for (const held of chains.get(sessionId)?.heldFiles ?? []) {
        staged.push({ localId: held.localId, file: held.file })
      }
      return staged
    },
    recoveryMaterials: (sessionId) => {
      if (retired) return []
      const prefix = `${sessionId}:`
      const views: ReferenceMaterialView[] = []
      for (const [key, recovery] of recoveryPending) {
        if (!key.startsWith(prefix)) continue
        views.push({
          id: recovery.idempotencyKey,
          kind: recovery.declaredKind,
          fileName: recovery.fileName,
          mimeType: recovery.declaredMimeType,
          byteSize: recovery.declaredByteSize,
          widthPx: null,
          heightPx: null,
          pixelCount: null,
          durationMs: null,
          checksumSha256: '',
          claimsVersion: 0,
          createdAt:
            recovery.putExpiresAt ?? recovery.finalizeExpiresAt ?? new Date(0).toISOString()
        })
      }
      for (const [key, material] of recoveredMaterials) {
        if (key.startsWith(prefix)) views.push(material)
      }
      return views
    },
    beginMaterialsObservation: (sessionId) => {
      const observation = (materialObservationEpochs.get(sessionId) ?? 0) + 1
      materialObservationEpochs.set(sessionId, observation)
      return observation
    },
    observeMaterials: (sessionId, materialIds, observation) => {
      const observed = new Set(materialIds)
      for (const [key, material] of recoveredMaterials) {
        if (!key.startsWith(`${sessionId}:`)) continue
        const floor = recoveredMaterialObservationFloors.get(key) ?? Number.MAX_SAFE_INTEGER
        if (!observed.has(material.id) && observation < floor) continue
        clearRecoveredMaterial(key)
        resolvedMaterialIds.delete(key)
      }
    },
    canReselectMaterial,
    resolvedMaterialId: (sessionId, localId) =>
      resolvedMaterialIds.get(materialKey(sessionId, localId)) ?? null,
    stageMaterial,
    replaceMaterial,
    submit,
    submitNewDraft,
    pendingDrafts: () => [...pendingDraftKeys],
    resumeSubmission: (sessionId) => {
      const chain = chains.get(sessionId)
      if (retired || chain?.state.status !== 'submission-unconfirmed') {
        return Promise.resolve(retired ? 'retired' : 'failed')
      }
      return sendSubmission(sessionId, chain)
    },
    recoverMaterialUploads,
    acknowledgeFailure: (sessionId) => {
      if (retired) return
      settledStates.delete(sessionId)
      clearMaterialFailures(sessionId)
      changed(sessionId)
    },
    stopTracking: (sessionId) => {
      chains.delete(sessionId)
      settledStates.delete(sessionId)
      clearMaterialFailures(sessionId)
      for (const key of [...ambiguousMaterials.keys()]) {
        if (key.startsWith(`${sessionId}:`)) ambiguousMaterials.delete(key)
      }
      for (const key of [...recoveryPending.keys()]) {
        if (!key.startsWith(`${sessionId}:`)) continue
        recoveryPending.delete(key)
        recoveryControllers.get(key)?.abort()
        recoveryControllers.delete(key)
        recoveryDeleting.delete(key)
        reselectionAllowed.delete(key)
      }
      for (const key of [...recoveredMaterials.keys()]) {
        if (key.startsWith(`${sessionId}:`)) clearRecoveredMaterial(key)
      }
      if (storage !== undefined) {
        for (const recovery of listReferenceMaterialUploadRecoveries(
          storage,
          userId,
          recoveryScope
        )) {
          if (recovery.sessionId !== sessionId) continue
          removeReferenceMaterialUploadRecovery(
            storage,
            userId,
            recoveryScope,
            recovery.idempotencyKey
          )
        }
      }
      syncNotice(sessionId)
      // Deferred deletions synchronously capture the old Promise or resolved
      // identity before the runtime releases its references below.
      flushDeletes(sessionId)
      for (const key of [...pendingMaterials.keys()]) {
        if (key.startsWith(`${sessionId}:`)) {
          pendingMaterials.delete(key)
          materialGenerations.delete(key)
          resolvedMaterialIds.delete(key)
          clearRecoveredMaterial(key)
          reselectionAllowed.delete(key)
        }
      }
      materialObservationEpochs.delete(sessionId)
      changed(sessionId)
    },
    deleteMaterial: (sessionId, materialId) =>
      requestMaterialDelete(sessionId, materialId, deleteMaterial),
    deleteSession: (sessionId) => {
      if (!chains.has(sessionId)) return runSessionDelete(sessionId)
      return new Promise((resolve) => {
        const queued = deferredSessionDeletes.get(sessionId) ?? []
        queued.push({ resolve })
        deferredSessionDeletes.set(sessionId, queued)
      })
    }
  }

  return { ...guardedPorts, userId, actions, retire }
}

function materialKindFor(mimeType: string): 'image' | 'video' | 'audio' {
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  return 'image'
}
