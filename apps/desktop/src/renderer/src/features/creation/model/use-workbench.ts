import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CapabilityManifest } from '../api/capability-manifest-http'
import { manifestDefaultParameters } from '../api/generation-parameter'
import type {
  CreationApiResult,
  CreationSessionView,
  DraftReferenceView,
  ReferenceMaterialView
} from '../api/go-creation-http'
import type {
  GenerationIntent,
  GenerationTaskDetail,
  GenerationTaskView
} from '../api/generation-task-http'
import type { ResultBlobUrlLease } from '../lib/result-blob-cache'
import { resultFilename } from '../lib/result-filename'
import { planFileDrop, type ResultDragPayload } from './reference-drop'
import {
  allowedReferenceKinds,
  mediaCapability,
  publishedModel,
  referenceCap,
  roleAcceptsKind,
  roleForPosition,
  staleDraftFields,
  type DraftMediaType,
  type DraftStaleField
} from './capability'
import {
  PENDING_DRAFT_KEY_PREFIX,
  readLocalDraft,
  type LocalDraftOperationNotice
} from './draft-store'
import {
  countPromptMentions,
  expandPromptDocument,
  promptDocumentLength,
  promptMentionCandidates,
  removePromptMentions,
  type PromptMentionCandidate,
  type PromptMentionKindLabels
} from './prompt-document'
import { useCreationRuntime, type CreationRuntime } from './runtime-context'
import { useTaskRefreshModule } from './task-refresh/use-task-refresh'
import type { TaskHistoryStatus } from './task-refresh/task-refresh-controller'
import { useWorkbenchDisplay } from './use-workbench-display'
import { useWorkbenchContext } from './use-workbench-context'
import {
  emptyComposerDraft,
  type ComposerDraft,
  type WorkbenchContextDeps,
  type WorkbenchStatus
} from './workbench-context-controller'
import type { WorkbenchActionState } from './workbench-runtime'
import type { MaterialThumbnailState, WorkbenchDisplayDeps } from './workbench-display-controller'

export type { ComposerDraft, WorkbenchStatus } from './workbench-context-controller'
export { emptyComposerDraft } from './workbench-context-controller'

export type ManifestStatus = 'loading' | 'ready' | 'unavailable'

export type { MaterialThumbnailState } from './workbench-display-controller'

/** One sidebar temporary entry: a draft whose submission started before any
 * session identity existed (`pending:<uuid>` ownership, ADR-0017). */
export interface PendingDraftEntry {
  readonly key: string
  readonly title: string
  readonly status: WorkbenchActionState['status']
}

interface StagedMaterial {
  readonly id: string
  readonly kind: ReferenceMaterialView['kind']
  readonly completion?: Promise<CreationApiResult<ReferenceMaterialView>>
}

/**
 * The Workbench composition point (issues #177, #206, #208). Provider
 * availability never gates editing — only the candidate menus and stale
 * verdicts come from the manifest.
 */

/** The presented Workbench Context: identity, entry actions, the session
 * list, and the action-lifecycle notices. */
export interface WorkbenchContextHandle {
  ports: CreationRuntime
  status: WorkbenchStatus
  reload: () => void
  sessions: readonly CreationSessionView[]
  selected: CreationSessionView | null
  selectedId: string | null
  /** True while the creator drafts against a session that does not exist yet. */
  composingNew: boolean
  /** The `pending:<uuid>` ownership being viewed, when a submitted-but-
   * unmaterialized draft is the active context. */
  pendingKey: string | null
  contextKey: string
  /** Temporary session-list entries for drafts without a session identity. */
  pendingDrafts: readonly PendingDraftEntry[]
  openPendingDraft: (key: string) => void
  selectSession: (session: CreationSessionView) => void
  startNewDraft: () => void
  deleteSession: (sessionId: string) => void
  renameSession: (sessionId: string, name: string) => void
  actionState: WorkbenchActionState
  operationNotice: LocalDraftOperationNotice | null
  resumeSubmission: () => void
  stopTracking: () => void
  reconcileAction: () => void
  submitError: string | null
  dismissSubmitError: () => void
}

/** The composer surface: the editable draft, its capability candidates and
 * stale verdicts, the reference deck, and the submit affordance. */
export interface WorkbenchComposerHandle {
  draft: ComposerDraft
  patchDraft: (patch: Partial<ComposerDraft>) => void
  setMediaType: (media: DraftMediaType) => void
  setModel: (model: string) => void
  setMode: (mode: string) => void
  manifest: CapabilityManifest | null
  manifestStatus: ManifestStatus
  staleFields: ReadonlySet<DraftStaleField>
  deckCap: ReturnType<typeof referenceCap>
  allowedKinds: ReturnType<typeof allowedReferenceKinds>
  mentionCandidates: readonly PromptMentionCandidate[]
  expandedPrompt: string
  promptLength: number
  promptMaxChars: number
  promptInvalid: boolean
  submit: () => void
  submitDisabled: boolean
  submitBlockedReason: 'unavailable' | 'stale' | 'length' | null
  materials: readonly ReferenceMaterialView[]
  thumbnails: Readonly<Record<string, string>>
  thumbnailStates: Readonly<Record<string, MaterialThumbnailState>>
  uploadProgress: Readonly<
    Record<string, { readonly sentBytes: number; readonly totalBytes: number }>
  >
  /** Resolved server id -> staged local id, for the deck's stable card key. */
  cardKeyAliases: Readonly<Record<string, string>>
  /** Holds one thumbnail while a mounted presentation can paint it. */
  retainMaterialThumbnail: (materialId: string) => () => void
  /** Starts an image thumbnail read only when a mounted presentation asks for it. */
  requestMaterialThumbnail: (materialId: string) => void
  /** Materials the prompt's Reference Mentions still name; replacing one would orphan them. */
  mentionedMaterialIds: ReadonlySet<string>
  /** Admits a dropped file batch against the mode's policy and adds what it accepts. */
  addMaterials: (files: readonly File[]) => void
  /** Swaps one bound card for a new file, keeping the deck position. */
  replaceMaterial: (materialId: string, file: File) => void
  /** Converts a succeeded task result into a new Reference Material (ADR-0018). */
  addResultAsMaterial: (payload: ResultDragPayload, targetMaterialId: string | null) => void
  removeMaterial: (materialId: string) => void
  pendingMaterialRemoval: { readonly materialId: string; readonly mentionCount: number } | null
  confirmMaterialRemoval: () => void
  dismissMaterialRemoval: () => void
  referenceRecoveryShown: boolean
  dismissReferenceRecovery: () => void
  /** True while the latest material upload failed; cleared by the next attempt. */
  materialUploadFailed: boolean
  /** Last drop's admission summary; null while nothing was rejected. */
  materialDropRejection: { readonly added: number; readonly rejected: number } | null
  /** Reads one server-backed or pending local Reference Material for UI presentation. */
  loadMaterialPreviewBlob: (materialId: string, signal?: AbortSignal) => Promise<Blob | null>
  /** The prompt editor's document identity: the user-scoped context key. */
  documentKey: string
}

/** The workspace surface: the task view with its refresh facts, the task
 * actions, result blob leases, and the reference pile's material display. */
export interface WorkbenchGalleryHandle {
  tasks: readonly GenerationTaskView[]
  taskDetails: Readonly<Record<string, GenerationTaskDetail>>
  taskDetailStaleIds: ReadonlySet<string>
  taskListStale: boolean
  taskHistory: TaskHistoryStatus
  loadOlderTasks: () => void
  /** Leases one succeeded slot's verified display URL until its card releases it. */
  acquireResultBlobUrl: (taskId: string, slotIndex: number) => Promise<ResultBlobUrlLease | null>
  cancelTask: (taskId: string) => void
  retryTask: (taskId: string) => void
  /** Retry of indeterminate work requires the creator's explicit risk confirm. */
  requestIndeterminateRedo: (taskId: string) => void
  confirmIndeterminateRedo: (taskId: string) => void
  indeterminateTaskId: string | null
  dismissIndeterminate: () => void
  /** The regenerate affordance re-submits the composer's draft. */
  submit: () => void
  submitDisabled: boolean
  materials: readonly ReferenceMaterialView[]
  thumbnails: Readonly<Record<string, string>>
  thumbnailStates: Readonly<Record<string, MaterialThumbnailState>>
  retainMaterialThumbnail: (materialId: string) => () => void
  requestMaterialThumbnail: (materialId: string) => void
}

export function useCreationWorkbench(): {
  readonly context: WorkbenchContextHandle
  readonly composer: WorkbenchComposerHandle
  readonly gallery: WorkbenchGalleryHandle
} {
  const ports = useCreationRuntime()
  const { t } = useTranslation('creation')
  const mentionKindLabels = useMemo<PromptMentionKindLabels>(
    () => ({
      image: String(t('composer.mention.kind.image')),
      video: String(t('composer.mention.kind.video')),
      audio: String(t('composer.mention.kind.audio'))
    }),
    [t]
  )

  const [manifest, setManifest] = useState<CapabilityManifest | null>(null)
  const [manifestStatus, setManifestStatus] = useState<ManifestStatus>('loading')
  const [indeterminateTaskId, setIndeterminateTaskId] = useState<string | null>(null)
  // Bumped on every runtime event: sidebar entries recompute even for
  // contexts the display is not showing.
  const [entriesRevision, setEntriesRevision] = useState(0)

  // The Generation Task refresh module (ADR-0005); business actions only ask
  // it to reconcile after they complete.
  const taskRefresh = useTaskRefreshModule(ports)
  const { tasks, taskDetails } = taskRefresh.snapshot

  // The display-resource module; every surface change goes through its one
  // context-switch reset.
  const displayDeps = useMemo<WorkbenchDisplayDeps | null>(() => {
    if (ports === null) return null
    return {
      loadMaterialBlob: (materialId, signal) => ports.loadMaterialBlob(materialId, signal),
      loadResultBlob: (taskId, slotIndex) => ports.loadResultBlob(taskId, slotIndex)
    }
  }, [ports])
  const display = useWorkbenchDisplay(displayDeps)
  const { materials, thumbnails, thumbnailStates, uploadProgress } = display.snapshot

  const mountedRef = useRef(false)
  const mentionKindLabelsRef = useRef<PromptMentionKindLabels>(mentionKindLabels)
  // The SSE subscription and the context controller's seams must survive
  // snapshot commits, so effects and memoized deps read the bindings
  // through refs instead of depending on their per-render identity.
  const taskRefreshRef = useRef(taskRefresh)
  const displayRef = useRef(display)

  // The Workbench Context controller (issue #206).
  const contextDeps = useMemo<WorkbenchContextDeps | null>(() => {
    if (ports === null) return null
    return {
      userId: ports.userId,
      listSessions: (cursor) => ports.listSessions(cursor),
      renameSession: (sessionId, name) => ports.renameSession(sessionId, name),
      getSessionDetail: (sessionId) => ports.getSessionDetail(sessionId),
      listMaterials: (sessionId, cursor) => ports.listMaterials(sessionId, cursor),
      actions: {
        snapshot: (key) => ports.actions.snapshot(key),
        stagedMaterials: (key) => ports.actions.stagedMaterials(key),
        recoveryMaterials: (key) => ports.actions.recoveryMaterials(key),
        beginMaterialsObservation: (key) => ports.actions.beginMaterialsObservation(key),
        observeMaterials: (key, materialIds, observation) =>
          ports.actions.observeMaterials(key, materialIds, observation),
        resolvedMaterialId: (sessionId, localId) =>
          ports.actions.resolvedMaterialId(sessionId, localId),
        deleteSession: (sessionId) => ports.actions.deleteSession(sessionId),
        acknowledgeFailure: (key) => ports.actions.acknowledgeFailure(key)
      },
      display: {
        reset: () => displayRef.current.reset(),
        replaceMaterials: (views) => displayRef.current.replaceMaterials(views),
        registerPending: (id, file) => displayRef.current.registerPending(id, file),
        dropPending: (materialId) => displayRef.current.dropPending(materialId),
        transferPending: (localId, resolvedId) =>
          displayRef.current.transferPending(localId, resolvedId),
        pendingFiles: () => displayRef.current.pendingFiles(),
        getSnapshot: () => displayRef.current.getSnapshot()
      },
      tasks: {
        enter: (sessionId) => taskRefreshRef.current.enter(sessionId),
        leave: () => taskRefreshRef.current.leave(),
        requestReconcile: () => taskRefreshRef.current.requestReconcile()
      }
    }
  }, [ports])
  const context = useWorkbenchContext(contextDeps)
  const { snapshot: ctx, controller: contextController } = context

  // Render cannot write refs; mirror the committed values after commit so
  // callbacks (submit, unmount cleanup) always read the latest bindings
  // without stale closures.
  useLayoutEffect(() => {
    mentionKindLabelsRef.current = mentionKindLabels
    taskRefreshRef.current = taskRefresh
    displayRef.current = display
  })

  useEffect(() => {
    // StrictMode's dev-only unmount/remount re-runs this effect while the ref
    // object persists, so liveness must be re-asserted on every run.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // A language change re-mirrors the localized prompt expansion into the
  // stored record through the context controller.
  useEffect(() => {
    contextController?.setMentionLabels(mentionKindLabels)
  }, [contextController, mentionKindLabels])

  // The manifest loads independently of sessions.
  useEffect(() => {
    if (!ports) return
    let active = true
    void (async () => {
      const result = await ports.loadCapabilityManifest().catch(() => null)
      if (!active) return
      if (result !== null && result.outcome === 'succeeded') {
        setManifest(result.value)
        setManifestStatus('ready')
        contextController?.noteManifest(result.value)
      } else {
        setManifestStatus('unavailable')
      }
    })()
    return () => {
      active = false
    }
  }, [contextController, ports])

  // The thin event route: one subscription translates runtime action events
  // into context-controller semantic calls; sidebar entries recompute on
  // every event.
  useEffect(() => {
    if (!ports || contextController === undefined) return
    return ports.actions.subscribe((event) => {
      if (event.type === 'material-progress') {
        displayRef.current.updateUploadProgress(event.localId, event.sentBytes, event.totalBytes)
        return
      }
      if (event.type === 'sessions-reconcile') {
        contextController.reload()
        setEntriesRevision((revision) => revision + 1)
        return
      }
      if (event.type === 'materialized') {
        contextController.noteSessionMaterialized(event.session, event.pendingKey)
        setEntriesRevision((revision) => revision + 1)
        return
      }
      setEntriesRevision((revision) => revision + 1)
      contextController.noteRuntimeEvent(event)
    })
  }, [contextController, ports])

  /** Same-tick-fresh draft read for orchestration callbacks. */
  const currentDraft = useCallback(
    (): ComposerDraft => contextController?.getSnapshot().draft ?? emptyComposerDraft(),
    [contextController]
  )

  /** Same-tick-fresh surface read: which session the workbench presents. */
  const currentSelectedId = useCallback(
    (): string | null => contextController?.getSnapshot().selectedId ?? null,
    [contextController]
  )

  const patchDraft = useCallback(
    (patch: Partial<ComposerDraft>) => {
      const controller = contextController
      if (controller === undefined) return
      controller.editDraft({ ...controller.getSnapshot().draft, ...patch })
    },
    [contextController]
  )

  const setMediaType = useCallback(
    (media: DraftMediaType) => {
      if (!ports) return
      const capability = mediaCapability(manifest, media)
      const published = capability?.available ? capability : null
      const model = (published?.models ?? [])[0]
      patchDraft({
        mediaType: media,
        model: model?.model ?? null,
        mode: published ? ((published.modes ?? [])[0]?.id ?? null) : null,
        resolution: model?.defaultResolution ?? null,
        ...manifestDefaultParameters(published)
      })
    },
    [manifest, patchDraft, ports]
  )

  // A creator-initiated model switch keeps the selected resolution only when
  // the new model publishes that tier; otherwise it adopts the new model's
  // default. (The never-rewrite rule guards manifest removals of a stored
  // draft, not the creator's own selection change.)
  const setModel = useCallback(
    (model: string) => {
      const draft = currentDraft()
      if (draft.mediaType === null) {
        patchDraft({ model })
        return
      }
      const entry = publishedModel(manifest, draft.mediaType, model)
      const current = draft.resolution
      const resolution =
        entry !== null && current !== null && entry.resolutions.includes(current)
          ? current
          : (entry?.defaultResolution ?? null)
      patchDraft({ model, resolution })
    },
    [currentDraft, manifest, patchDraft]
  )

  // Re-derives binding roles for one published mode; a binding whose
  // material kind cannot structurally fill the new role (the server twin is
  // roleAcceptsKind) keeps its previous role, so the draft stays submittable
  // and the stale reference note — never a silent rewrite — explains the
  // mismatch.
  const bindingsForMode = useCallback(
    (media: DraftMediaType, mode: string, references: DraftReferenceView[]) => {
      if (roleForPosition(media, mode, 0) === null) return references
      const kindOf = new Map(materials.map((material) => [material.id, material.kind] as const))
      return references.map((reference, position) => {
        const nextRole = roleForPosition(media, mode, position)
        const kind = kindOf.get(reference.materialId)
        if (nextRole === null || kind === undefined || !roleAcceptsKind(nextRole, kind)) {
          return reference
        }
        return { ...reference, role: nextRole }
      })
    },
    [materials]
  )

  const setMode = useCallback(
    (mode: string) => {
      const draft = currentDraft()
      // Re-derive binding roles only for published modes; a stale mode keeps
      // every stored binding untouched.
      const rederived =
        draft.mediaType === null
          ? draft.references
          : bindingsForMode(draft.mediaType, mode, draft.references)
      patchDraft({ mode, references: rederived })
    },
    [bindingsForMode, currentDraft, patchDraft]
  )

  /** Existing-session uploads belong to the renderer-document runtime, so
   * route navigation only drops their display resources. New-session files
   * remain device-local until that later context materializes (ADR-0017). */
  const stageMaterialFile = useCallback(
    (file: File): StagedMaterial | null => {
      if (!ports) return null
      const id = crypto.randomUUID()
      const material = displayRef.current.registerPending(id, file)
      const sessionId = currentSelectedId()
      if (sessionId === null) return { id, kind: material.kind }
      return {
        id,
        kind: material.kind,
        completion: ports.actions.stageMaterial(sessionId, id, file)
      }
    },
    [currentSelectedId, ports]
  )

  const addMaterial = useCallback(
    async (file: File) => {
      if (!ports) return
      contextController?.noteMaterialUploadFailed(false)
      contextController?.noteMaterialDropRejection(null)
      const staged = stageMaterialFile(file)
      if (staged === null) return
      // The structural fallback keeps every kind submittable: images take the
      // image role, anything else binds as omni (which accepts all kinds).
      const draft = currentDraft()
      const media = draft.mediaType
      const derived =
        media === null ? null : roleForPosition(media, draft.mode, draft.references.length)
      const role = derived ?? (staged.kind === 'image' ? 'reference' : 'omni')
      const binding: DraftReferenceView = { materialId: staged.id, role }
      const nextReferences = [...draft.references, binding]
      if (media === 'image') {
        // Image modes derive from the deck: any reference means the
        // reference-image shape, and the bindings re-derive their roles with
        // it — the composer offers no image mode picker (video modes are
        // not deck-derivable).
        patchDraft({
          references: bindingsForMode(media, 'reference-image', nextReferences),
          mode: 'reference-image'
        })
      } else {
        patchDraft({ references: nextReferences })
      }
    },
    [bindingsForMode, contextController, currentDraft, patchDraft, ports, stageMaterialFile]
  )

  const removeMaterialNow = useCallback(
    async (materialId: string) => {
      if (!ports) return
      contextController?.notePendingMaterialRemoval(null)
      const draft = currentDraft()
      const remaining = draft.references.filter((entry) => entry.materialId !== materialId)
      const promptDocument = removePromptMentions(draft.promptDocument, materialId)
      if (draft.mediaType === 'image') {
        // The deck's emptiness flips the derived image mode back: an empty
        // reference-image draft could never satisfy its own minimum.
        const mode = remaining.length > 0 ? 'reference-image' : 'text-to-image'
        patchDraft({
          promptDocument,
          references: bindingsForMode('image', mode, remaining),
          mode
        })
      } else {
        patchDraft({ promptDocument, references: remaining })
      }
      displayRef.current.forget(materialId)
      displayRef.current.dropPending(materialId)
      const sessionId = currentSelectedId()
      // A locally-held new-session file never reached the server; only its
      // local records die with the removal. Existing-session files may still
      // be uploading, so the runtime resolves their real identity before it
      // retires the server material.
      if (sessionId !== null) await ports.actions.deleteMaterial(sessionId, materialId)
    },
    [bindingsForMode, contextController, currentDraft, currentSelectedId, patchDraft, ports]
  )

  const requestMaterialRemoval = useCallback(
    (materialId: string) => {
      const mentionCount = countPromptMentions(currentDraft().promptDocument, materialId)
      if (mentionCount === 0) {
        void removeMaterialNow(materialId)
        return
      }
      contextController?.notePendingMaterialRemoval({ materialId, mentionCount })
    },
    [contextController, currentDraft, removeMaterialNow]
  )

  const confirmMaterialRemoval = useCallback(() => {
    if (ctx.pendingMaterialRemoval !== null) {
      void removeMaterialNow(ctx.pendingMaterialRemoval.materialId)
    }
  }, [ctx.pendingMaterialRemoval, removeMaterialNow])

  // The SSE stream only hints that server facts changed; the refresh module
  // owns when to read them, and it answers a lost stream with its own
  // fallback polling and reconnect reconciliation (ADR-0005).
  useEffect(() => {
    if (!ports) return
    const unsubscribe = ports.subscribeEvents({
      onInvalidation: () => {
        taskRefreshRef.current.notifyInvalidation()
      },
      onStateChange: (live) => {
        taskRefreshRef.current.setStreamLive(live)
      },
      // The authenticated-use-period runtime retires every action and port.
      onUnauthorized: () => undefined
    })
    return unsubscribe
  }, [ports])

  /** Freezes every user-visible field at the click boundary. A draft without
   * session identity claims independent ownership out of the `new` slot
   * BEFORE the materialization request leaves; resubmitting a pending entry
   * reuses its key as a new action (ADR-0017). */
  const submit = useCallback(() => {
    if (!ports || contextController === undefined) return
    const frozenDraft = contextController.getSnapshot().draft
    const candidates = promptMentionCandidates(
      frozenDraft.references,
      displayRef.current.getSnapshot().materials,
      mentionKindLabelsRef.current
    )
    const { promptDocument, ...plainIntent } = frozenDraft
    const intent: GenerationIntent = {
      ...plainIntent,
      prompt: expandPromptDocument(promptDocument, candidates),
      manifestVersion: contextController.manifestVersionForIntent(),
      references: frozenDraft.references.map((reference) => ({ ...reference }))
    }
    const { pendingKey, selectedId } = contextController.getSnapshot()
    if (pendingKey === null && selectedId !== null) {
      contextController.editDraft(frozenDraft)
      void ports.actions.submit(selectedId, intent)
      return
    }
    const key = pendingKey ?? `${PENDING_DRAFT_KEY_PREFIX}${crypto.randomUUID()}`
    // Frozen reference order, then deck leftovers: identity binding must not
    // depend on upload completion order.
    const filesById = new Map(displayRef.current.pendingFiles())
    const files: Array<{ localId: string; file: File }> = []
    const boundIds = new Set<string>()
    for (const reference of frozenDraft.references) {
      const entry = filesById.get(reference.materialId)
      if (entry === undefined) continue
      files.push({ localId: reference.materialId, file: entry.file })
      boundIds.add(reference.materialId)
    }
    for (const [localId, entry] of filesById) {
      if (!boundIds.has(localId)) files.push({ localId, file: entry.file })
    }
    if (pendingKey === null) contextController.claimPendingDraft(key, frozenDraft)
    else contextController.editDraft(frozenDraft)
    // submitNewDraft stages the files synchronously before its first await,
    // so the re-entry below re-registers them from the runtime's hold.
    void ports.actions.submitNewDraft(key, intent, files)
    contextController.enterContext({ kind: 'pending', key })
  }, [contextController, ports])

  // The composer's submit affordance: a void adapter so the JSX handler can
  // stay a plain reference.
  const submitCallback = useCallback(() => {
    submit()
  }, [submit])

  const cancelTaskById = useCallback(
    (taskId: string) => {
      void ports
        ?.cancelTask(taskId)
        .then(() => taskRefreshRef.current.requestReconcile())
        .catch(() => undefined)
    },
    [ports]
  )

  const retryTaskById = useCallback(
    (taskId: string) => {
      void ports
        ?.retryTask(taskId, crypto.randomUUID())
        .then((result) => {
          if (result.outcome === 'succeeded') {
            setIndeterminateTaskId(null)
            taskRefreshRef.current.requestReconcile()
          }
        })
        .catch(() => undefined)
    },
    [ports]
  )

  const confirmIndeterminateRedo = useCallback(
    (taskId: string) => retryTaskById(taskId),
    [retryTaskById]
  )

  const staleFields: ReadonlySet<DraftStaleField> = useMemo(
    () =>
      staleDraftFields(manifest, {
        ...ctx.draft
      }),
    [ctx.draft, manifest]
  )

  const mentionCandidates = useMemo(
    () => promptMentionCandidates(ctx.draft.references, materials, mentionKindLabels),
    [ctx.draft.references, materials, mentionKindLabels]
  )
  // The deck's replace aim must refuse cards the prompt still names through
  // Reference Mentions — replacing one is a removal under the hood.
  const mentionedMaterialIds = useMemo(() => {
    const mentioned = new Set<string>()
    for (const material of materials) {
      if (countPromptMentions(ctx.draft.promptDocument, material.id) > 0) mentioned.add(material.id)
    }
    return mentioned
  }, [ctx.draft.promptDocument, materials])
  const expandedPrompt = useMemo(
    () => expandPromptDocument(ctx.draft.promptDocument, mentionCandidates),
    [ctx.draft.promptDocument, mentionCandidates]
  )
  const promptLength = promptDocumentLength(ctx.draft.promptDocument, mentionCandidates)
  const currentCapability =
    ctx.draft.mediaType === null ? null : mediaCapability(manifest, ctx.draft.mediaType)
  const promptMinChars =
    currentCapability?.available === true ? (currentCapability.prompt?.minChars ?? 1) : 1
  const promptMaxChars =
    currentCapability?.available === true ? (currentCapability.prompt?.maxChars ?? 2000) : 2000
  const promptInvalid = promptLength < promptMinChars || promptLength > promptMaxChars

  const actionBlocksSubmission =
    ctx.actionState.status === 'preparing' ||
    ctx.actionState.status === 'submitting' ||
    ctx.actionState.status === 'session-unconfirmed' ||
    ctx.actionState.status === 'submission-unconfirmed' ||
    ctx.actionState.status === 'material-unconfirmed' ||
    ctx.actionState.status === 'retired'

  const submitBlocked: 'unavailable' | 'stale' | 'length' | null = (() => {
    if (ctx.draft.mediaType === null || ctx.draft.model === null || ctx.draft.mode === null)
      return 'unavailable'
    // Submission freezes a manifest-conformant intent: without the current
    // manifest the client cannot vouch for the draft, so the command stays
    // inert (the server would reject it as stale or unavailable anyway).
    const capability = mediaCapability(manifest, ctx.draft.mediaType)
    if (manifestStatus !== 'ready' || capability === null || !capability.available) {
      return 'unavailable'
    }
    if (promptInvalid) return 'length'
    if (staleFields.size > 0) return 'stale'
    return null
  })()

  const deckCap = referenceCap(
    manifest,
    ctx.draft.mediaType ?? 'image',
    ctx.draft.model,
    ctx.draft.mode
  )
  const allowedKinds = allowedReferenceKinds(manifest, ctx.draft.mediaType, ctx.draft.mode)

  /**
   * Adds a dropped batch: admission is judged once against the deck's current
   * capacity and the mode's kinds, then admitted files flow through the same
   * upload path as the picker (drop order preserved); the summary line
   * reports the rejected remainder. The server stays the final authority.
   */
  const addMaterials = useCallback(
    (files: readonly File[]): void => {
      if (!ports || files.length === 0) return
      void (async () => {
        const remaining = Math.max(0, deckCap - currentDraft().references.length)
        const plan = planFileDrop(files, allowedKinds, remaining)
        for (const file of plan.accepted) {
          await addMaterial(file)
          if (!mountedRef.current) return
        }
        const rejected = plan.rejectedKind + plan.rejectedCap
        if (rejected > 0) {
          contextController?.noteMaterialDropRejection({ added: plan.accepted.length, rejected })
        }
      })()
    },
    [addMaterial, allowedKinds, contextController, currentDraft, deckCap, ports]
  )

  /**
   * Swaps one bound card for a new file at the same deck position. The new
   * upload happens before the old material retires, so a failed upload
   * leaves the deck untouched. A material the prompt still mentions is never
   * replaced (that removal path needs the mention-confirm dialog) — such a
   * drop falls back to a plain append.
   */
  const replaceMaterial = useCallback(
    (materialId: string, file: File): void => {
      if (!ports) return
      void (async () => {
        const draftNow = currentDraft()
        const position = draftNow.references.findIndex(
          (binding) => binding.materialId === materialId
        )
        const replaceable =
          displayRef.current
            .getSnapshot()
            .materials.some((candidate) => candidate.id === materialId) &&
          position >= 0 &&
          countPromptMentions(draftNow.promptDocument, materialId) === 0
        if (!replaceable) {
          addMaterials([file])
          return
        }
        contextController?.noteMaterialUploadFailed(false)
        contextController?.noteMaterialDropRejection(null)
        const sessionIdAtStart = currentSelectedId()
        const replacementId =
          sessionIdAtStart !== null &&
          ports.actions.canReselectMaterial(sessionIdAtStart, materialId)
            ? materialId
            : crypto.randomUUID()
        const pendingReplacement = displayRef.current.registerPending(replacementId, file)
        const initialKept = draftNow.references.filter(
          (binding) => binding.materialId !== materialId
        )
        const initialInsertAt = Math.min(position, initialKept.length)
        const fallbackRole = pendingReplacement.kind === 'image' ? 'reference' : 'omni'
        const initialRole =
          (draftNow.mediaType !== null
            ? roleForPosition(draftNow.mediaType, draftNow.mode, initialInsertAt)
            : null) ?? fallbackRole
        const staged: StagedMaterial = {
          id: replacementId,
          kind: pendingReplacement.kind,
          ...(sessionIdAtStart === null
            ? {}
            : {
                completion: ports.actions.replaceMaterial(
                  sessionIdAtStart,
                  materialId,
                  replacementId,
                  file,
                  initialRole
                )
              })
        }
        // The old binding retires only after the runtime confirms the new
        // material and finishes the original context's delete action.
        let replacement = staged
        if (staged.completion !== undefined) {
          const result = await staged.completion
          if (result.outcome !== 'succeeded') {
            if (
              result.outcome !== 'network-failure' &&
              mountedRef.current &&
              currentSelectedId() === sessionIdAtStart
            ) {
              displayRef.current.forget(staged.id)
              displayRef.current.dropPending(staged.id)
            }
            return
          }
          if (!mountedRef.current || currentSelectedId() !== sessionIdAtStart) return
          // Forgetting here is the same blink the restore merge's
          // transferPending exists to prevent.
          displayRef.current.transferPending(staged.id, result.value.id)
          replacement = { id: result.value.id, kind: result.value.kind }
          const currentMaterials = displayRef.current
            .getSnapshot()
            .materials.filter((material) => material.id !== staged.id)
          if (!currentMaterials.some((material) => material.id === result.value.id)) {
            displayRef.current.replaceMaterials([...currentMaterials, result.value])
          }
        }
        displayRef.current.dropPending(materialId)
        displayRef.current.forget(materialId)
        // Merge into the latest Draft, not the click-time snapshot: prompt,
        // parameter, and other reference edits remain authoritative while
        // the runtime finishes the upload/delete action.
        const latestDraft = currentDraft()
        const latestPosition = latestDraft.references.findIndex(
          (binding) => binding.materialId === materialId
        )
        if (latestPosition < 0) return
        const kept = latestDraft.references.filter((binding) => binding.materialId !== materialId)
        const insertAt = Math.min(latestPosition, kept.length)
        const role =
          (latestDraft.mediaType !== null
            ? roleForPosition(latestDraft.mediaType, latestDraft.mode, insertAt)
            : null) ?? fallbackRole
        kept.splice(insertAt, 0, { materialId: replacement.id, role })
        if (latestDraft.mediaType === 'image') {
          patchDraft({
            references: bindingsForMode('image', 'reference-image', kept),
            mode: 'reference-image'
          })
        } else {
          patchDraft({ references: kept })
        }
      })()
    },
    [
      addMaterials,
      bindingsForMode,
      contextController,
      currentDraft,
      currentSelectedId,
      patchDraft,
      ports
    ]
  )

  /** A dragged result is copied by the creator-authorized Server command;
   * result bytes and Storage capabilities never enter the Renderer. */
  const addResultAsMaterial = useCallback(
    (payload: ResultDragPayload, targetMaterialId: string | null): void => {
      if (!ports) return
      void (async () => {
        const sessionId = currentSelectedId()
        if (sessionId === null) return
        contextController?.noteMaterialUploadFailed(false)
        contextController?.noteMaterialDropRejection(null)
        const resultFacts = taskDetails[payload.taskId]?.slots.find(
          (slot) => slot.index === payload.slotIndex
        )?.result
        const result = await ports
          .createMaterialFromResult(sessionId, {
            taskId: payload.taskId,
            slotIndex: payload.slotIndex,
            fileName: resultFilename(
              payload.taskId,
              payload.slotIndex,
              payload.mediaType,
              resultFacts?.mimeType ?? null
            )
          })
          .catch(() => ({ outcome: 'network-failure' }) as const)
        if (!mountedRef.current || currentSelectedId() !== sessionId) return
        if (result.outcome !== 'succeeded') {
          contextController?.noteMaterialUploadFailed(true)
          return
        }
        const created = result.value
        const draftAtResult = currentDraft()
        const targetPosition =
          targetMaterialId === null
            ? -1
            : draftAtResult.references.findIndex(
                (binding) => binding.materialId === targetMaterialId
              )
        const replaceable =
          targetMaterialId !== null &&
          targetPosition >= 0 &&
          displayRef.current
            .getSnapshot()
            .materials.some((candidate) => candidate.id === targetMaterialId) &&
          countPromptMentions(draftAtResult.promptDocument, targetMaterialId) === 0

        if (replaceable && targetMaterialId !== null) {
          const fallbackRole = created.kind === 'image' ? 'reference' : 'omni'
          const deletion = await ports.actions.deleteMaterial(sessionId, targetMaterialId)
          if (!mountedRef.current || currentSelectedId() !== sessionId) return
          if (deletion.outcome !== 'succeeded') {
            contextController?.noteMaterialUploadFailed(true)
            return
          }
          displayRef.current.dropPending(targetMaterialId)
          displayRef.current.forget(targetMaterialId)
          displayRef.current.replaceMaterials([
            ...displayRef.current
              .getSnapshot()
              .materials.filter((material) => material.id !== targetMaterialId),
            created
          ])
          const latestDraft = currentDraft()
          const latestPosition = latestDraft.references.findIndex(
            (binding) => binding.materialId === targetMaterialId
          )
          if (latestPosition < 0) return
          const kept = latestDraft.references.filter(
            (binding) => binding.materialId !== targetMaterialId
          )
          const insertAt = Math.min(latestPosition, kept.length)
          const role =
            (latestDraft.mediaType !== null
              ? roleForPosition(latestDraft.mediaType, latestDraft.mode, insertAt)
              : null) ?? fallbackRole
          kept.splice(insertAt, 0, { materialId: created.id, role })
          if (latestDraft.mediaType === 'image') {
            patchDraft({
              references: bindingsForMode('image', 'reference-image', kept),
              mode: 'reference-image'
            })
          } else {
            patchDraft({ references: kept })
          }
          return
        }

        displayRef.current.replaceMaterials([
          ...displayRef.current
            .getSnapshot()
            .materials.filter((material) => material.id !== created.id),
          created
        ])
        const latestDraft = currentDraft()
        const role =
          (latestDraft.mediaType !== null
            ? roleForPosition(
                latestDraft.mediaType,
                latestDraft.mode,
                latestDraft.references.length
              )
            : null) ?? (created.kind === 'image' ? 'reference' : 'omni')
        const references = [
          ...latestDraft.references,
          { materialId: created.id, role }
        ] satisfies DraftReferenceView[]
        if (latestDraft.mediaType === 'image') {
          patchDraft({
            references: bindingsForMode('image', 'reference-image', references),
            mode: 'reference-image'
          })
        } else {
          patchDraft({ references })
        }
      })()
    },
    [
      bindingsForMode,
      contextController,
      currentDraft,
      currentSelectedId,
      patchDraft,
      ports,
      taskDetails
    ]
  )

  /** Sidebar entries titled by their persisted prompt. */
  const pendingDrafts = useMemo<readonly PendingDraftEntry[]>(() => {
    void entriesRevision
    if (ports === null) return []
    const storage = globalThis.localStorage
    return ports.actions.pendingDrafts().map((key) => {
      const stored = storage === undefined ? null : readLocalDraft(storage, ports.userId, key)
      return {
        key,
        title: (stored?.prompt ?? '').trim().split('\n')[0],
        status: ports.actions.snapshot(key).status
      }
    })
  }, [entriesRevision, ports])

  // The composer's submit circle and the gallery's regenerate gate on one verdict.
  const submitDisabled = submitBlocked !== null || actionBlocksSubmission

  return {
    context: {
      ports,
      status: ctx.status,
      reload: (): void => contextController?.reload(),
      sessions: ctx.sessions,
      selected: ctx.selected,
      selectedId: ctx.selectedId,
      composingNew: ctx.composingNew,
      pendingKey: ctx.pendingKey,
      contextKey: ctx.contextKey,
      pendingDrafts,
      openPendingDraft: (key: string) => {
        contextController?.enterContext({ kind: 'pending', key })
      },
      selectSession: (session: CreationSessionView) => {
        contextController?.enterContext({ kind: 'session', session })
      },
      startNewDraft: () => {
        contextController?.enterContext({ kind: 'new' })
      },
      deleteSession: (sessionId: string) => {
        contextController?.deleteSession(sessionId)
      },
      renameSession: (sessionId: string, name: string) => {
        contextController?.renameSession(sessionId, name)
      },
      actionState: ctx.actionState,
      operationNotice: ctx.operationNotice,
      resumeSubmission: () => {
        const key = ctx.actionKey
        if (key !== null) void ports?.actions.resumeSubmission(key)
      },
      stopTracking: () => {
        if (!ports || contextController === undefined) return
        const key = contextController.getSnapshot().actionKey
        if (key === null) return
        ports.actions.stopTracking(key)
        contextController.reconcileCurrentContext()
      },
      reconcileAction: () => {
        if (ports === null) {
          contextController?.reconcileCurrentContext()
          return
        }
        void ports.actions
          .recoverMaterialUploads()
          .finally(() => contextController?.reconcileCurrentContext())
      },
      submitError: ctx.submitError,
      dismissSubmitError: () => {
        contextController?.acknowledgeActionFailure()
      }
    },
    composer: {
      draft: ctx.draft,
      patchDraft,
      setMediaType,
      setModel,
      setMode,
      manifest,
      manifestStatus,
      staleFields,
      deckCap,
      allowedKinds,
      mentionCandidates,
      expandedPrompt,
      promptLength,
      promptMaxChars,
      promptInvalid,
      submit: submitCallback,
      submitDisabled,
      submitBlockedReason: submitBlocked,
      materials,
      thumbnails,
      thumbnailStates,
      uploadProgress,
      cardKeyAliases: display.snapshot.cardKeyAliases,
      retainMaterialThumbnail: display.retain,
      requestMaterialThumbnail: display.requestThumbnail,
      mentionedMaterialIds,
      addMaterials,
      replaceMaterial,
      addResultAsMaterial,
      removeMaterial: requestMaterialRemoval,
      pendingMaterialRemoval: ctx.pendingMaterialRemoval,
      confirmMaterialRemoval,
      dismissMaterialRemoval: () => contextController?.notePendingMaterialRemoval(null),
      referenceRecoveryShown: ctx.referenceRecoveryShown,
      dismissReferenceRecovery: () => contextController?.dismissReferenceRecovery(),
      materialUploadFailed: ctx.materialUploadFailed,
      materialDropRejection: ctx.materialDropRejection,
      loadMaterialPreviewBlob: display.loadMaterialPreviewBlob,
      documentKey: `${ports?.userId ?? ''}:${ctx.contextKey}`
    },
    gallery: {
      tasks,
      taskDetails,
      taskDetailStaleIds: taskRefresh.snapshot.staleTaskIds,
      taskListStale: taskRefresh.snapshot.listFailed,
      taskHistory: taskRefresh.snapshot.history,
      loadOlderTasks: taskRefresh.requestOlderTasks,
      acquireResultBlobUrl: display.acquireResultBlobUrl,
      cancelTask: cancelTaskById,
      retryTask: retryTaskById,
      requestIndeterminateRedo: (taskId: string) => setIndeterminateTaskId(taskId),
      confirmIndeterminateRedo,
      indeterminateTaskId,
      dismissIndeterminate: () => setIndeterminateTaskId(null),
      submit: submitCallback,
      submitDisabled,
      materials,
      thumbnails,
      thumbnailStates,
      retainMaterialThumbnail: display.retain,
      requestMaterialThumbnail: display.requestThumbnail
    }
  }
}
