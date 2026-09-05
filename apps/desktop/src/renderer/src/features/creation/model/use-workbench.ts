import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CapabilityManifest } from '../api/capability-manifest-http'
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
import { loadImageDimensions } from '../lib/image-dimensions'
import { MaterialUrlOwner } from '../lib/material-url-owner'
import { ResultBlobCache, type ResultBlobUrlLease } from '../lib/result-blob-cache'
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
  removeLocalDraft,
  writeLocalDraft,
  type LocalDraftOperationNotice,
  type LocalDraftRecord
} from './draft-store'
import {
  countPromptMentions,
  expandPromptDocument,
  promptDocumentLength,
  promptMentionCandidates,
  prunePromptMentions,
  removePromptMentions,
  textPromptDocument,
  type PromptDocument,
  type PromptMentionCandidate,
  type PromptMentionKindLabels
} from './prompt-document'
import { useCreationRuntime, type CreationRuntime } from './runtime-context'
import { useTaskRefreshModule } from './task-refresh/use-task-refresh'
import type { WorkbenchActionState } from './workbench-runtime'

export type WorkbenchStatus = 'loading' | 'ready' | 'error'

export type ManifestStatus = 'loading' | 'ready' | 'unavailable'

export type MaterialThumbnailState = 'loading' | 'failed' | 'ready'

/**
 * The composer's editable mirror of the session draft. Field values are
 * exactly what the creator sees; the manifest only adds candidate menus and
 * stale verdicts, it never rewrites these values.
 */
export interface ComposerDraft {
  promptDocument: PromptDocument
  mediaType: DraftMediaType | null
  model: string | null
  mode: string | null
  ratio: string | null
  resolution: string | null
  quantity: number | null
  durationSeconds: number | null
  references: DraftReferenceView[]
}

export const emptyComposerDraft = (): ComposerDraft => ({
  promptDocument: textPromptDocument(''),
  mediaType: null,
  model: null,
  mode: null,
  ratio: null,
  resolution: null,
  quantity: null,
  durationSeconds: null,
  references: []
})

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

/**
 * The Workbench orchestration (issue #177): private session list state, the
 * selected session's materials, the Capability Manifest, and the device-local
 * draft with its write-through store (ADR-0017). Provider availability never
 * gates editing — only the candidate menus and stale verdicts come from the
 * manifest.
 */
export interface CreationWorkbenchController {
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
  /** Temporary session-list entries for drafts without a session identity. */
  pendingDrafts: readonly PendingDraftEntry[]
  /** Returns to one pending draft's context through its temporary entry. */
  openPendingDraft: (key: string) => void
  selectSession: (session: CreationSessionView) => void
  startNewDraft: () => void
  deleteSession: (sessionId: string) => void
  renameSession: (sessionId: string, name: string) => void
  materials: readonly ReferenceMaterialView[]
  thumbnails: Readonly<Record<string, string>>
  thumbnailStates: Readonly<Record<string, MaterialThumbnailState>>
  /** Holds one thumbnail while a mounted presentation can paint it. */
  retainMaterialThumbnail: (materialId: string) => () => void
  /** Starts an image thumbnail read only when a mounted presentation asks for it. */
  requestMaterialThumbnail: (materialId: string) => void
  draft: ComposerDraft
  mentionCandidates: readonly PromptMentionCandidate[]
  expandedPrompt: string
  promptLength: number
  promptMaxChars: number
  promptInvalid: boolean
  patchDraft: (patch: Partial<ComposerDraft>) => void
  setMediaType: (media: DraftMediaType) => void
  setModel: (model: string) => void
  setMode: (mode: string) => void
  addMaterial: (file: File) => void
  /** Admits a dropped file batch against the mode's policy and adds what it accepts. */
  addMaterials: (files: readonly File[]) => void
  /** Swaps one bound card for a new file, keeping the deck position. */
  replaceMaterial: (materialId: string, file: File) => void
  /** Re-uploads a succeeded task result as a new Reference Material (ADR-0018). */
  addResultAsMaterial: (payload: ResultDragPayload, targetMaterialId: string | null) => void
  /** Materials the prompt's Reference Mentions still name; replacing one would orphan them. */
  mentionedMaterialIds: ReadonlySet<string>
  /** Last drop's admission summary; null while nothing was rejected. */
  materialDropRejection: { readonly added: number; readonly rejected: number } | null
  removeMaterial: (materialId: string) => void
  pendingMaterialRemoval: { readonly materialId: string; readonly mentionCount: number } | null
  confirmMaterialRemoval: () => void
  dismissMaterialRemoval: () => void
  referenceRecoveryShown: boolean
  dismissReferenceRecovery: () => void
  /** True while the latest material upload failed; cleared by the next attempt. */
  materialUploadFailed: boolean
  manifest: CapabilityManifest | null
  manifestStatus: ManifestStatus
  staleFields: ReadonlySet<DraftStaleField>
  deckCap: ReturnType<typeof referenceCap>
  allowedKinds: ReturnType<typeof allowedReferenceKinds>
  tasks: readonly GenerationTaskView[]
  taskDetails: Readonly<Record<string, GenerationTaskDetail>>
  /** Refresh-module snapshot fields (see TaskRefreshSnapshot). */
  taskDetailStaleIds: ReadonlySet<string>
  taskListStale: boolean
  submitDisabled: boolean
  submitBlockedReason: 'unavailable' | 'stale' | 'length' | null
  submit: () => void
  actionState: WorkbenchActionState
  operationNotice: LocalDraftOperationNotice | null
  resumeSubmission: () => void
  stopTracking: () => void
  reconcileAction: () => void
  cancelTask: (taskId: string) => void
  retryTask: (taskId: string) => void
  submitError: string | null
  dismissSubmitError: () => void
  /** Leases one succeeded slot's verified display URL until its card releases it. */
  acquireResultBlobUrl: (taskId: string, slotIndex: number) => Promise<ResultBlobUrlLease | null>
  /** Reads one server-backed or pending local Reference Material for UI presentation. */
  loadMaterialPreviewBlob: (materialId: string, signal?: AbortSignal) => Promise<Blob | null>
  /** Retry of indeterminate work requires the creator's explicit risk confirm. */
  requestIndeterminateRedo: (taskId: string) => void
  confirmIndeterminateRedo: (taskId: string) => void
  indeterminateTaskId: string | null
  dismissIndeterminate: () => void
}

export function useCreationWorkbench(): CreationWorkbenchController {
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

  const [status, setStatus] = useState<WorkbenchStatus>('loading')
  const [sessions, setSessions] = useState<readonly CreationSessionView[]>([])
  const [reloadAttempt, setReloadAttempt] = useState(0)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [composingNew, setComposingNew] = useState(false)
  // The `pending:<uuid>` ownership being viewed, when a submitted-but-
  // unmaterialized draft is the active context.
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [materials, setMaterials] = useState<readonly ReferenceMaterialView[]>([])
  const [thumbnails, setThumbnails] = useState<Readonly<Record<string, string>>>({})
  const [thumbnailStates, setThumbnailStates] = useState<
    Readonly<Record<string, MaterialThumbnailState>>
  >({})
  const [draft, setDraft] = useState<ComposerDraft>(emptyComposerDraft)
  const [materialUploadFailed, setMaterialUploadFailed] = useState(false)
  const [materialDropRejection, setMaterialDropRejection] = useState<{
    readonly added: number
    readonly rejected: number
  } | null>(null)
  const [manifest, setManifest] = useState<CapabilityManifest | null>(null)
  const [manifestStatus, setManifestStatus] = useState<ManifestStatus>('loading')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [indeterminateTaskId, setIndeterminateTaskId] = useState<string | null>(null)
  const [actionRevision, setActionRevision] = useState(0)
  // Bumped on every runtime event: sidebar entries recompute even for
  // contexts the display is not showing.
  const [entriesRevision, setEntriesRevision] = useState(0)
  const [operationNotice, setOperationNotice] = useState<LocalDraftOperationNotice | null>(null)
  const [pendingMaterialRemoval, setPendingMaterialRemoval] = useState<{
    readonly materialId: string
    readonly mentionCount: number
  } | null>(null)
  const [referenceRecoveryShown, setReferenceRecoveryShown] = useState(false)

  // The Generation Task refresh module (ADR-0005): scheduling, coalescing,
  // and consistent task display live behind this binding; business actions
  // only ask it to reconcile after they complete.
  const taskRefresh = useTaskRefreshModule(ports)
  const { tasks, taskDetails } = taskRefresh.snapshot

  // Manifest adoption can write through in the same turn it updates React;
  // keep the last seen version synchronous so that write cannot persist the
  // previous fallback version.
  const seenManifestVersionRef = useRef<number | null>(null)
  // The manifest version of the last restored local record, kept so edits
  // before the manifest arrives still record the version the draft was last
  // edited under.
  const recordManifestVersionRef = useRef<number | null>(null)
  // True from a surface switch's optimistic reset until its local record (or
  // the fallback) lands: the reset looks like an "untouched empty draft", and
  // manifest adoption running inside that window would write seeded defaults
  // straight through to the store, clobbering the record about to restore.
  const restoreInFlightRef = useRef(false)
  const draftRef = useRef<ComposerDraft>(draft)
  const selectedIdRef = useRef<string | null>(selectedId)
  const composingNewRef = useRef(false)
  const pendingKeyRef = useRef<string | null>(pendingKey)
  const mountedRef = useRef(false)
  const displayGenerationRef = useRef(0)
  const operationNoticeRef = useRef<LocalDraftOperationNotice | null>(null)
  const materialIdsRef = useRef<ReadonlySet<string>>(new Set())
  const materialsRef = useRef<readonly ReferenceMaterialView[]>([])
  const mentionKindLabelsRef = useRef<PromptMentionKindLabels>(mentionKindLabels)
  const thumbnailLoadRef = useRef(0)
  const thumbnailIdsRef = useRef<ReadonlySet<string>>(new Set())
  const thumbnailRequestsRef = useRef(new Map<string, number>())
  const thumbnailConsumersRef = useRef(new Map<string, number>())
  const materialUrlsRef = useRef<MaterialUrlOwner | null>(null)
  if (materialUrlsRef.current === null) materialUrlsRef.current = new MaterialUrlOwner()
  const portsRef = useRef<CreationRuntime>(ports)
  const resultBlobCacheRef = useRef<ResultBlobCache | null>(null)
  // The SSE subscription must survive snapshot commits, so its effect reads
  // the binding through a ref instead of depending on its identity.
  const taskRefreshRef = useRef(taskRefresh)

  /** The version a persisted record/submission carries: what the composer
   * last saw, else the restored record's own, else the contract floor. */
  const intentManifestVersion = (): number =>
    seenManifestVersionRef.current ?? recordManifestVersionRef.current ?? 1

  /**
   * Files added while composing a session that does not exist yet, keyed by
   * their synthetic material id. They upload when the session materializes at
   * submit time; until then nothing about them ever reaches the server.
   */
  const pendingMaterialFilesRef = useRef(new Map<string, { file: File }>())

  /** Drops one pending file's local records, revoking its preview URL. */
  const dropPendingMaterial = (materialId: string): void => {
    const pending = pendingMaterialFilesRef.current.get(materialId)
    if (pending === undefined) return
    pendingMaterialFilesRef.current.delete(materialId)
    materialUrlsRef.current?.releaseMaterial(materialId)
    setThumbnails((current) => {
      if (!(materialId in current)) return current
      const next = { ...current }
      delete next[materialId]
      return next
    })
    setThumbnailStates((current) => {
      if (!(materialId in current)) return current
      const next = { ...current }
      delete next[materialId]
      return next
    })
  }

  // Render cannot write refs; mirror the committed values after commit so
  // callbacks (write-through, submit, unmount cleanup) always read the latest
  // state without stale closures.
  useLayoutEffect(() => {
    draftRef.current = draft
    selectedIdRef.current = selectedId
    composingNewRef.current = composingNew
    pendingKeyRef.current = pendingKey
    materialsRef.current = materials
    materialIdsRef.current = new Set(materials.map((material) => material.id))
    mentionKindLabelsRef.current = mentionKindLabels
    thumbnailIdsRef.current = new Set(Object.keys(thumbnails))
    portsRef.current = ports
    taskRefreshRef.current = taskRefresh
  })

  useEffect(() => {
    // StrictMode's dev-only unmount/remount re-runs this effect while the ref
    // object persists, so liveness must be re-asserted on every run.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      displayGenerationRef.current += 1
    }
  }, [])

  /** Write-through keyed by the composing surface: `pending:<uuid>`, else
   * `new`, else the session (ADR-0017). */
  const writeDraftThrough = useCallback(
    (value: ComposerDraft): void => {
      if (ports === null) return
      const storage = globalThis.localStorage
      if (storage === undefined) return
      const key = pendingKeyRef.current ?? (composingNewRef.current ? 'new' : selectedIdRef.current)
      if (key === null) return
      const candidates = promptMentionCandidates(
        value.references,
        materialsRef.current,
        mentionKindLabelsRef.current
      )
      const record: LocalDraftRecord = {
        ...value,
        prompt: expandPromptDocument(value.promptDocument, candidates),
        manifestVersion: intentManifestVersion(),
        ...(operationNoticeRef.current === null
          ? {}
          : { operationNotice: operationNoticeRef.current })
      }
      writeLocalDraft(storage, ports.userId, key, record)
    },
    [ports]
  )

  const displayedContextKey = (): string | null => pendingKeyRef.current ?? selectedIdRef.current

  const patchDraft = useCallback(
    (patch: Partial<ComposerDraft>) => {
      const next = { ...draftRef.current, ...patch }
      draftRef.current = next
      setDraft(next)
      writeDraftThrough(next)
    },
    [writeDraftThrough]
  )

  // The fallback mirrors the currently localized expansion even though the
  // identity-bearing PromptDocument remains unchanged.
  useEffect(() => {
    writeDraftThrough(draftRef.current)
  }, [mentionKindLabels, writeDraftThrough])

  /** The manifest-seeded draft a brand-new empty session starts from. */
  const manifestDefaultDraft = useCallback((value: CapabilityManifest): ComposerDraft | null => {
    const media: DraftMediaType | null = value.image.available
      ? 'image'
      : value.video.available
        ? 'video'
        : null
    if (media === null) return null
    const capability = mediaCapability(value, media)
    if (capability === null || !capability.available) return null
    const first = (capability.modes ?? [])[0]
    const model = (capability.models ?? [])[0]
    return {
      promptDocument: textPromptDocument(''),
      mediaType: media,
      model: model?.model ?? null,
      mode: first ? first.id : null,
      ratio: capability.defaults?.ratio ?? null,
      resolution: model?.defaultResolution ?? null,
      quantity: capability.defaults?.quantity ?? null,
      durationSeconds: capability.defaults?.duration ?? null,
      references: []
    }
  }, [])

  /** A brand-new draft adopts the manifest defaults exactly once. */
  const adoptManifestDefaults = useCallback(
    (value: CapabilityManifest) => {
      // Only an untouched empty draft is auto-configured; anything the
      // creator (or a stored draft) holds is never rewritten — including the
      // optimistic empty a surface switch shows while its record restores.
      if (restoreInFlightRef.current) return
      if (JSON.stringify(draftRef.current) !== JSON.stringify(emptyComposerDraft())) return
      if (selectedIdRef.current === null && !composingNewRef.current) return
      const seeded = manifestDefaultDraft(value)
      if (seeded === null) return
      patchDraft(seeded)
    },
    [manifestDefaultDraft, patchDraft]
  )

  // The Workbench reloads its session list whenever the ports identity
  // changes; loading/empty/error stay explicit so cached data can never
  // masquerade as authoritative server facts.
  useEffect(() => {
    if (!ports) return
    let active = true
    void (async () => {
      const result = await ports.listSessions().catch(() => null)
      if (!active) return
      if (result !== null && result.outcome === 'succeeded') {
        setSessions(result.value.sessions)
        setStatus('ready')
      } else {
        setStatus('error')
      }
    })()
    return () => {
      active = false
    }
  }, [ports, reloadAttempt])

  // The manifest loads independently of sessions: its failure degrades the
  // candidate menus and stale verdicts, never drafting itself.
  useEffect(() => {
    if (!ports) return
    let active = true
    void (async () => {
      const result = await ports.loadCapabilityManifest().catch(() => null)
      if (!active) return
      if (result !== null && result.outcome === 'succeeded') {
        seenManifestVersionRef.current = result.value.manifestVersion
        setManifest(result.value)
        setManifestStatus('ready')
        adoptManifestDefaults(result.value)
      } else {
        setManifestStatus('unavailable')
      }
    })()
    return () => {
      active = false
    }
  }, [adoptManifestDefaults, ports])

  // The Feature-local owners revoke thumbnails, pending-file previews, and
  // cached result URLs when this surface ends.
  useEffect(
    () => () => {
      thumbnailLoadRef.current += 1
      thumbnailRequestsRef.current.clear()
      thumbnailConsumersRef.current.clear()
      materialUrlsRef.current?.dispose()
      resultBlobCacheRef.current?.dispose()
    },
    []
  )

  const applyLoadedDraft = useCallback(
    (
      stored: ComposerDraft | null,
      manifestVersion: number | null,
      nextOperationNotice: LocalDraftOperationNotice | null = null,
      resetTransient = true
    ) => {
      const value = stored ?? emptyComposerDraft()
      recordManifestVersionRef.current = manifestVersion
      operationNoticeRef.current = nextOperationNotice
      setOperationNotice(nextOperationNotice)
      draftRef.current = value
      setDraft(value)
      if (resetTransient) {
        setMaterialUploadFailed(false)
        // A surface switch must not carry the previous surface's drop summary.
        setMaterialDropRejection(null)
      }
    },
    []
  )

  // --- Generation Task kernel (issue #159) ---------------------------------
  // Task list/detail reading, refresh scheduling, and consistent display are
  // owned by the refresh module (ADR-0005): entering a session starts a new
  // display lifecycle there, and nothing below rewrites task display state.

  /** Unknown-material bindings drop out; their last expanded prompt survives
   * as plain text — identity cannot be reconstructed after a material
   * disappears, so nothing is guessed at. */
  const restoreStoredDraft = useCallback(
    (stored: LocalDraftRecord, knownMaterialIds: ReadonlySet<string>): ComposerDraft => {
      const references = stored.references.filter((reference) =>
        knownMaterialIds.has(reference.materialId)
      )
      const prunedPromptDocument = prunePromptMentions(stored.promptDocument, references)
      const recovered =
        references.length !== stored.references.length ||
        JSON.stringify(prunedPromptDocument) !== JSON.stringify(stored.promptDocument)
      // Identity cannot be reconstructed after a material disappears. Keep
      // the last visible expansion as ordinary text instead of losing prompt
      // content or guessing which surviving label carried which identity.
      const promptDocument = recovered ? textPromptDocument(stored.prompt) : prunedPromptDocument
      if (recovered) setReferenceRecoveryShown(true)
      let value: ComposerDraft = {
        promptDocument,
        mediaType: stored.mediaType,
        model: stored.model,
        mode: stored.mode,
        ratio: stored.ratio,
        resolution: stored.resolution,
        quantity: stored.quantity,
        durationSeconds: stored.durationSeconds,
        references
      }
      if (
        stored.mediaType === 'image' &&
        references.length === 0 &&
        stored.mode === 'reference-image'
      ) {
        // The deck's emptiness flips the derived image mode back: an empty
        // reference-image draft could never satisfy its own minimum.
        value = { ...value, mode: 'text-to-image' }
      }
      return value
    },
    []
  )

  const selectSession = useCallback(
    async (session: CreationSessionView, preserveTransient = false) => {
      if (!ports) return
      const displayGeneration = ++displayGenerationRef.current
      if (!preserveTransient) {
        setReferenceRecoveryShown(false)
        setPendingMaterialRemoval(null)
        setComposingNew(false)
        composingNewRef.current = false
        setPendingKey(null)
        pendingKeyRef.current = null
        for (const materialId of pendingMaterialFilesRef.current.keys())
          dropPendingMaterial(materialId)
        thumbnailLoadRef.current += 1
        thumbnailRequestsRef.current.clear()
        thumbnailConsumersRef.current.clear()
        materialUrlsRef.current?.dispose()
        resultBlobCacheRef.current?.dispose()
        setSelectedId(session.id)
        selectedIdRef.current = session.id
        materialsRef.current = []
        materialIdsRef.current = new Set()
        thumbnailIdsRef.current = new Set()
        setMaterials([])
        setThumbnails({})
        setThumbnailStates({})
        // A real display switch must not expose facts or editable state from
        // the prior context while this session restores.
        applyLoadedDraft(null, null)
      }
      const actionSnapshot = ports.actions.snapshot(session.id)
      setSubmitError(actionSnapshot.status === 'failed' ? actionSnapshot.code : null)
      restoreInFlightRef.current = true
      if (preserveTransient) taskRefreshRef.current.requestReconcile()
      else taskRefreshRef.current.enter(session.id)
      const [detail, materialPage] = await Promise.all([
        ports.getSessionDetail(session.id).catch(() => null),
        ports.listMaterials(session.id).catch(() => null)
      ])
      if (!mountedRef.current) return
      if (displayGenerationRef.current !== displayGeneration) return
      if (selectedIdRef.current !== session.id) return
      if (
        detail === null ||
        detail.outcome !== 'succeeded' ||
        materialPage === null ||
        materialPage.outcome !== 'succeeded'
      ) {
        restoreInFlightRef.current = false
        // A background reconcile is best-effort: its outage must not erase
        // the current editable Draft or replace still-useful Go facts.
        if (!preserveTransient) {
          setStatus('error')
          setSelectedId(null)
          selectedIdRef.current = null
          taskRefreshRef.current.leave()
        }
        return
      }
      const staged = ports.actions.stagedMaterials(session.id)
      const stagedIds = new Set(staged.map((entry) => entry.localId))
      for (const materialId of pendingMaterialFilesRef.current.keys()) {
        if (!stagedIds.has(materialId)) dropPendingMaterial(materialId)
      }
      const stagedViews = staged
        .filter(
          (entry) => !materialPage.value.materials.some((material) => material.id === entry.localId)
        )
        .map((entry) => {
          pendingMaterialFilesRef.current.set(entry.localId, { file: entry.file })
          return pendingMaterialView(entry.localId, entry.file)
        })
      const visibleMaterials = [...materialPage.value.materials, ...stagedViews]
      setMaterials(visibleMaterials)
      materialsRef.current = visibleMaterials
      materialIdsRef.current = new Set(visibleMaterials.map((material) => material.id))
      // The editable draft is device-local state: restore this device's copy
      // and prune reference bindings whose materials no longer exist in the
      // session (deleted from another surface — nothing rewrote them here).
      const stored = readLocalDraft(globalThis.localStorage, ports.userId, session.id)
      if (stored === null) {
        applyLoadedDraft(
          manifest === null ? null : manifestDefaultDraft(manifest),
          null,
          null,
          !preserveTransient
        )
      } else {
        const known = new Set(visibleMaterials.map((material) => material.id))
        const value = restoreStoredDraft(stored, known)
        applyLoadedDraft(
          value,
          stored.manifestVersion,
          stored.operationNotice ?? null,
          !preserveTransient
        )
        writeDraftThrough(value)
        if (seenManifestVersionRef.current === null) {
          seenManifestVersionRef.current = stored.manifestVersion
        }
      }
      restoreInFlightRef.current = false
    },
    [applyLoadedDraft, manifest, manifestDefaultDraft, ports, restoreStoredDraft, writeDraftThrough]
  )

  const syncOperationNotice = useCallback(
    (sessionId: string): void => {
      if (!ports) return
      const stored = readLocalDraft(globalThis.localStorage, ports.userId, sessionId)
      const notice = stored?.operationNotice ?? null
      operationNoticeRef.current = notice
      setOperationNotice(notice)
    },
    [ports]
  )

  const reconcileAction = useCallback((): void => {
    // A pending draft's check is a session-list read — see whether a session
    // appeared, never claim one.
    if (pendingKeyRef.current !== null) {
      setReloadAttempt((attempt) => attempt + 1)
      return
    }
    const sessionId = selectedIdRef.current
    if (sessionId === null) return
    const session = sessions.find((candidate) => candidate.id === sessionId)
    if (session !== undefined) void selectSession(session, true)
  }, [selectSession, sessions])

  // Runtime events update only the displayed context; hidden contexts keep
  // running without background reads. Sidebar entries recompute on every event.
  useEffect(() => {
    if (!ports) return
    return ports.actions.subscribe((event) => {
      if (event.type === 'sessions-reconcile') {
        setReloadAttempt((attempt) => attempt + 1)
        setEntriesRevision((revision) => revision + 1)
        return
      }
      if (event.type === 'materialized') {
        // Only the surface still watching this pending draft follows the
        // conversion; every other display keeps its own context (ADR-0005).
        setEntriesRevision((revision) => revision + 1)
        setSessions((current) => [
          event.session,
          ...current.filter((session) => session.id !== event.session.id)
        ])
        if (pendingKeyRef.current === event.pendingKey) {
          void selectSession(event.session)
        }
        return
      }
      setEntriesRevision((revision) => revision + 1)
      const contextKey = displayedContextKey()
      if (contextKey === null) return
      if (event.sessionId !== '' && event.sessionId !== contextKey) return
      setActionRevision((revision) => revision + 1)
      syncOperationNotice(contextKey)
      const state = ports.actions.snapshot(contextKey)
      if (state.status === 'retired') {
        taskRefreshRef.current.leave()
        return
      }
      if (state.status === 'failed') setSubmitError(state.code)
      if (event.type !== 'reconcile') return
      if (pendingKeyRef.current !== null) {
        setReloadAttempt((attempt) => attempt + 1)
        return
      }
      const session = sessions.find((candidate) => candidate.id === contextKey)
      if (session !== undefined) void selectSession(session, true)
    })
  }, [ports, selectSession, sessions, syncOperationNotice])

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
        ratio: published?.defaults?.ratio ?? null,
        quantity: published?.defaults?.quantity ?? null,
        durationSeconds: published?.defaults?.duration ?? null
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
      const media = draftRef.current.mediaType
      if (media === null) {
        patchDraft({ model })
        return
      }
      const entry = publishedModel(manifest, media, model)
      const current = draftRef.current.resolution
      const resolution =
        entry !== null && current !== null && entry.resolutions.includes(current)
          ? current
          : (entry?.defaultResolution ?? null)
      patchDraft({ model, resolution })
    },
    [manifest, patchDraft]
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
      const media = draftRef.current.mediaType
      // Re-derive binding roles only for published modes; a stale mode keeps
      // every stored binding untouched.
      const rederived =
        media === null
          ? draftRef.current.references
          : bindingsForMode(media, mode, draftRef.current.references)
      patchDraft({ mode, references: rederived })
    },
    [bindingsForMode, patchDraft]
  )

  /**
   * Enters the composer without a server session: the draft lives locally and
   * the session materializes only when a task is actually submitted. A fresh
   * round seeds from the manifest defaults exactly like a never-edited
   * session; a surviving local composing draft restores instead.
   */
  const startNewDraft = useCallback(() => {
    if (!ports) return
    if (composingNewRef.current) return
    displayGenerationRef.current += 1
    setReferenceRecoveryShown(false)
    setPendingMaterialRemoval(null)
    setSubmitError(null)
    setComposingNew(true)
    composingNewRef.current = true
    setSelectedId(null)
    selectedIdRef.current = null
    setPendingKey(null)
    pendingKeyRef.current = null
    for (const materialId of pendingMaterialFilesRef.current.keys()) {
      dropPendingMaterial(materialId)
    }
    thumbnailLoadRef.current += 1
    thumbnailRequestsRef.current.clear()
    thumbnailConsumersRef.current.clear()
    materialUrlsRef.current?.dispose()
    resultBlobCacheRef.current?.dispose()
    materialsRef.current = []
    materialIdsRef.current = new Set()
    thumbnailIdsRef.current = new Set()
    setMaterials([])
    setThumbnails({})
    setThumbnailStates({})
    taskRefreshRef.current.leave()
    // startNewDraft resolves synchronously, but the same adoption guard as
    // selectSession keeps a manifest response landing mid-reset from seeding.
    restoreInFlightRef.current = true
    const storage = globalThis.localStorage
    const stored = storage === undefined ? null : readLocalDraft(storage, ports.userId, 'new')
    if (stored === null) {
      applyLoadedDraft(manifest === null ? null : manifestDefaultDraft(manifest), null)
    } else {
      // Pending files cannot survive a restart; their bindings die with them.
      const value = restoreStoredDraft(stored, new Set())
      applyLoadedDraft(value, stored.manifestVersion, stored.operationNotice ?? null)
      writeDraftThrough(value)
      if (seenManifestVersionRef.current === null) {
        seenManifestVersionRef.current = stored.manifestVersion
      }
    }
    restoreInFlightRef.current = false
  }, [
    applyLoadedDraft,
    manifest,
    manifestDefaultDraft,
    ports,
    restoreStoredDraft,
    writeDraftThrough
  ])

  const deleteSession = useCallback(
    async (sessionId: string) => {
      if (!ports) return
      const result = await ports.actions.deleteSession(sessionId)
      if (result.outcome !== 'succeeded' || !mountedRef.current) return
      if (selectedIdRef.current === sessionId) {
        displayGenerationRef.current += 1
        setReferenceRecoveryShown(false)
        setPendingMaterialRemoval(null)
        setSubmitError(null)
        selectedIdRef.current = null
        setSelectedId(null)
        thumbnailLoadRef.current += 1
        thumbnailRequestsRef.current.clear()
        thumbnailConsumersRef.current.clear()
        materialUrlsRef.current?.dispose()
        resultBlobCacheRef.current?.dispose()
        materialsRef.current = []
        materialIdsRef.current = new Set()
        thumbnailIdsRef.current = new Set()
        setMaterials([])
        setThumbnails({})
        setThumbnailStates({})
        applyLoadedDraft(null, null)
        taskRefreshRef.current.leave()
      }
      setSessions((current) => current.filter((session) => session.id !== sessionId))
    },
    [applyLoadedDraft, ports]
  )

  useEffect(() => {
    const sessionId = selectedIdRef.current
    if (
      status !== 'ready' ||
      sessionId === null ||
      sessions.some((session) => session.id === sessionId)
    ) {
      return
    }
    displayGenerationRef.current += 1
    setReferenceRecoveryShown(false)
    setPendingMaterialRemoval(null)
    setSubmitError(null)
    selectedIdRef.current = null
    setSelectedId(null)
    thumbnailLoadRef.current += 1
    thumbnailRequestsRef.current.clear()
    thumbnailConsumersRef.current.clear()
    materialUrlsRef.current?.dispose()
    resultBlobCacheRef.current?.dispose()
    materialsRef.current = []
    materialIdsRef.current = new Set()
    thumbnailIdsRef.current = new Set()
    setMaterials([])
    setThumbnails({})
    setThumbnailStates({})
    applyLoadedDraft(null, null)
    taskRefreshRef.current.leave()
  }, [applyLoadedDraft, sessions, status])

  const renameSession = useCallback(
    (sessionId: string, name: string) => {
      // `selected` derives from this list, so the workspace title follows.
      // Optimistic like deleteSession: a failed PATCH surfaces on the next
      // reload instead of rolling the visible name back.
      setSessions((current) =>
        current.map((session) => (session.id === sessionId ? { ...session, name } : session))
      )
      void ports?.renameSession(sessionId, name).catch(() => undefined)
    },
    [ports]
  )

  const requestMaterialThumbnail = useCallback(
    (materialId: string): void => {
      if (!ports) return
      const load = thumbnailLoadRef.current
      const material = materialsRef.current.find((candidate) => candidate.id === materialId)
      if (
        material?.kind !== 'image' ||
        (thumbnailConsumersRef.current.get(materialId) ?? 0) === 0 ||
        thumbnailIdsRef.current.has(materialId) ||
        thumbnailRequestsRef.current.get(materialId) === load
      ) {
        return
      }
      thumbnailRequestsRef.current.set(materialId, load)
      setThumbnailStates((current) => ({ ...current, [materialId]: 'loading' }))
      const isCurrent = (): boolean =>
        mountedRef.current &&
        load === thumbnailLoadRef.current &&
        materialIdsRef.current.has(materialId) &&
        (thumbnailConsumersRef.current.get(materialId) ?? 0) > 0
      const pendingFile = pendingMaterialFilesRef.current.get(materialId)?.file
      const blob = pendingFile
        ? Promise.resolve<Blob | null>(pendingFile)
        : ports
            .loadMaterialBlob(materialId)
            .then((result) => (result.outcome === 'succeeded' ? result.value : null))
      void blob
        .then((blob) => {
          if (!isCurrent()) return
          if (!blob) {
            setThumbnailStates((current) => ({ ...current, [materialId]: 'failed' }))
            return
          }
          const url = materialUrlsRef.current!.replaceThumbnail(materialId, blob)
          thumbnailIdsRef.current = new Set([...thumbnailIdsRef.current, materialId])
          setThumbnails((current) => ({ ...current, [materialId]: url }))
          setThumbnailStates((current) => ({ ...current, [materialId]: 'ready' }))
        })
        .catch(() => {
          if (isCurrent()) {
            setThumbnailStates((current) => ({ ...current, [materialId]: 'failed' }))
          }
        })
        .finally(() => {
          if (thumbnailRequestsRef.current.get(materialId) === load) {
            thumbnailRequestsRef.current.delete(materialId)
          }
        })
    },
    [ports]
  )

  const retainMaterialThumbnail = useCallback(
    (materialId: string): (() => void) => {
      const load = thumbnailLoadRef.current
      thumbnailConsumersRef.current.set(
        materialId,
        (thumbnailConsumersRef.current.get(materialId) ?? 0) + 1
      )
      requestMaterialThumbnail(materialId)
      let released = false
      return () => {
        if (released) return
        released = true
        if (load !== thumbnailLoadRef.current) return
        const consumers = thumbnailConsumersRef.current.get(materialId) ?? 0
        if (consumers > 1) {
          thumbnailConsumersRef.current.set(materialId, consumers - 1)
          return
        }
        thumbnailConsumersRef.current.delete(materialId)
        materialUrlsRef.current?.releaseMaterial(materialId)
        thumbnailIdsRef.current = new Set(
          [...thumbnailIdsRef.current].filter((candidate) => candidate !== materialId)
        )
        if (!mountedRef.current) return
        setThumbnails((current) => {
          if (!(materialId in current)) return current
          const next = { ...current }
          delete next[materialId]
          return next
        })
        setThumbnailStates((current) => {
          if (!(materialId in current)) return current
          const next = { ...current }
          delete next[materialId]
          return next
        })
      }
    },
    [requestMaterialThumbnail]
  )

  const registerPendingMaterial = useCallback((id: string, file: File): ReferenceMaterialView => {
    const previewUrl = file.type.startsWith('image/')
      ? materialUrlsRef.current!.replaceThumbnail(id, file)
      : null
    pendingMaterialFilesRef.current.set(id, { file })
    const material = pendingMaterialView(id, file)
    materialsRef.current = [...materialsRef.current, material]
    materialIdsRef.current = new Set([...materialIdsRef.current, id])
    setMaterials((current) => [...current, material])
    if (previewUrl !== null) {
      setThumbnails((current) => ({ ...current, [id]: previewUrl }))
      void loadImageDimensions(previewUrl).then((dimensions) => {
        if (
          dimensions === null ||
          !mountedRef.current ||
          !pendingMaterialFilesRef.current.has(id)
        ) {
          return
        }
        const withDimensions = (entry: ReferenceMaterialView): ReferenceMaterialView =>
          entry.id === id
            ? {
                ...entry,
                widthPx: dimensions.width,
                heightPx: dimensions.height,
                pixelCount: dimensions.width * dimensions.height
              }
            : entry
        materialsRef.current = materialsRef.current.map(withDimensions)
        setMaterials((current) => current.map(withDimensions))
      })
    }
    return material
  }, [])

  /** Existing-session uploads belong to the renderer-document runtime, so
   * route navigation only drops their display resources. New-session files
   * remain device-local until that later context materializes (ADR-0017). */
  const stageMaterialFile = useCallback(
    (file: File): StagedMaterial | null => {
      if (!ports) return null
      const id = crypto.randomUUID()
      const material = registerPendingMaterial(id, file)
      const sessionId = selectedIdRef.current
      if (sessionId === null) return { id, kind: material.kind }
      return {
        id,
        kind: material.kind,
        completion: ports.actions.stageMaterial(sessionId, id, file)
      }
    },
    [ports, registerPendingMaterial]
  )

  /** The temporary entry's return path: no server facts are read (no identity
   * exists); the deck rebinds to runtime-held files, or to the record alone
   * when the chain died before a reload. */
  const openPendingDraft = useCallback(
    (key: string) => {
      if (!ports) return
      displayGenerationRef.current += 1
      setReferenceRecoveryShown(false)
      setPendingMaterialRemoval(null)
      setComposingNew(false)
      composingNewRef.current = false
      setSelectedId(null)
      selectedIdRef.current = null
      setPendingKey(key)
      pendingKeyRef.current = key
      for (const materialId of pendingMaterialFilesRef.current.keys()) {
        dropPendingMaterial(materialId)
      }
      thumbnailLoadRef.current += 1
      thumbnailRequestsRef.current.clear()
      thumbnailConsumersRef.current.clear()
      materialUrlsRef.current?.dispose()
      resultBlobCacheRef.current?.dispose()
      materialsRef.current = []
      materialIdsRef.current = new Set()
      thumbnailIdsRef.current = new Set()
      setMaterials([])
      setThumbnails({})
      setThumbnailStates({})
      taskRefreshRef.current.leave()
      restoreInFlightRef.current = true
      const actionSnapshot = ports.actions.snapshot(key)
      setSubmitError(actionSnapshot.status === 'failed' ? actionSnapshot.code : null)
      const staged = ports.actions.stagedMaterials(key)
      const stagedIds = new Set<string>()
      for (const entry of staged) {
        stagedIds.add(entry.localId)
        registerPendingMaterial(entry.localId, entry.file)
      }
      const storage = globalThis.localStorage
      const stored = storage === undefined ? null : readLocalDraft(storage, ports.userId, key)
      if (stored === null) {
        applyLoadedDraft(manifest === null ? null : manifestDefaultDraft(manifest), null)
      } else {
        const value = restoreStoredDraft(stored, stagedIds)
        applyLoadedDraft(value, stored.manifestVersion, stored.operationNotice ?? null)
        writeDraftThrough(value)
        if (seenManifestVersionRef.current === null) {
          seenManifestVersionRef.current = stored.manifestVersion
        }
      }
      restoreInFlightRef.current = false
    },
    [
      applyLoadedDraft,
      manifest,
      manifestDefaultDraft,
      ports,
      registerPendingMaterial,
      restoreStoredDraft,
      writeDraftThrough
    ]
  )

  /** Drops one material from every local record, thumbnail entry included —
   * a stale entry would leave consumers (task-card piles) holding a revoked
   * object URL; the caller settles its bytes (pending file vs server
   * delete) around this. */
  const forgetMaterialRecords = useCallback((materialId: string): void => {
    setMaterials((current) => current.filter((material) => material.id !== materialId))
    setThumbnails((current) => {
      if (!(materialId in current)) return current
      const next = { ...current }
      delete next[materialId]
      return next
    })
    setThumbnailStates((current) => {
      if (!(materialId in current)) return current
      const next = { ...current }
      delete next[materialId]
      return next
    })
    thumbnailIdsRef.current = new Set(
      [...thumbnailIdsRef.current].filter((candidate) => candidate !== materialId)
    )
    thumbnailConsumersRef.current.delete(materialId)
    materialsRef.current = materialsRef.current.filter((material) => material.id !== materialId)
    materialIdsRef.current = new Set(
      [...materialIdsRef.current].filter((candidate) => candidate !== materialId)
    )
  }, [])

  const addMaterial = useCallback(
    async (file: File) => {
      if (!ports) return
      setMaterialUploadFailed(false)
      setMaterialDropRejection(null)
      const staged = stageMaterialFile(file)
      if (staged === null) return
      // The structural fallback keeps every kind submittable: images take the
      // image role, anything else binds as omni (which accepts all kinds).
      const media = draftRef.current.mediaType
      const derived =
        media === null
          ? null
          : roleForPosition(media, draftRef.current.mode, draftRef.current.references.length)
      const role = derived ?? (staged.kind === 'image' ? 'reference' : 'omni')
      const binding: DraftReferenceView = { materialId: staged.id, role }
      const nextReferences = [...draftRef.current.references, binding]
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
    [bindingsForMode, patchDraft, ports, stageMaterialFile]
  )

  const removeMaterialNow = useCallback(
    async (materialId: string) => {
      if (!ports) return
      setPendingMaterialRemoval(null)
      const remaining = draftRef.current.references.filter(
        (entry) => entry.materialId !== materialId
      )
      const promptDocument = removePromptMentions(draftRef.current.promptDocument, materialId)
      if (draftRef.current.mediaType === 'image') {
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
      forgetMaterialRecords(materialId)
      materialUrlsRef.current?.releaseMaterial(materialId)
      const sessionId = selectedIdRef.current
      // A locally-held new-session file never reached the server; only its
      // local records die with the removal. Existing-session files may still
      // be uploading, so the runtime resolves their real identity before it
      // retires the server material.
      if (sessionId === null && pendingMaterialFilesRef.current.has(materialId)) {
        dropPendingMaterial(materialId)
        return
      }
      dropPendingMaterial(materialId)
      if (sessionId !== null) await ports.actions.deleteMaterial(sessionId, materialId)
    },
    [bindingsForMode, forgetMaterialRecords, patchDraft, ports]
  )

  const requestMaterialRemoval = useCallback(
    (materialId: string) => {
      const mentionCount = countPromptMentions(draftRef.current.promptDocument, materialId)
      if (mentionCount === 0) {
        void removeMaterialNow(materialId)
        return
      }
      setPendingMaterialRemoval({ materialId, mentionCount })
    },
    [removeMaterialNow]
  )

  const confirmMaterialRemoval = useCallback(() => {
    if (pendingMaterialRemoval !== null) {
      void removeMaterialNow(pendingMaterialRemoval.materialId)
    }
  }, [pendingMaterialRemoval, removeMaterialNow])

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
    if (!ports) return
    const frozenDraft = draftRef.current
    const candidates = promptMentionCandidates(
      frozenDraft.references,
      materialsRef.current,
      mentionKindLabelsRef.current
    )
    const { promptDocument, ...plainIntent } = frozenDraft
    const intent: GenerationIntent = {
      ...plainIntent,
      prompt: expandPromptDocument(promptDocument, candidates),
      manifestVersion: intentManifestVersion(),
      references: frozenDraft.references.map((reference) => ({ ...reference }))
    }
    if (pendingKeyRef.current === null && selectedIdRef.current !== null) {
      writeDraftThrough(frozenDraft)
      setSubmitError(null)
      void ports.actions.submit(selectedIdRef.current, intent)
      return
    }
    const key = pendingKeyRef.current ?? `${PENDING_DRAFT_KEY_PREFIX}${crypto.randomUUID()}`
    // Frozen reference order, then deck leftovers: identity binding must not
    // depend on upload completion order.
    const filesById = new Map(pendingMaterialFilesRef.current)
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
    if (pendingKeyRef.current === null) {
      // The record lands under the pending key and the composing key dies,
      // synchronously — before any await.
      setComposingNew(false)
      composingNewRef.current = false
      pendingKeyRef.current = key
      setPendingKey(key)
      writeDraftThrough(frozenDraft)
      const storage = globalThis.localStorage
      if (storage !== undefined) removeLocalDraft(storage, ports.userId, 'new')
    } else {
      writeDraftThrough(frozenDraft)
    }
    setSubmitError(null)
    // submitNewDraft stages the files synchronously before its first await,
    // so the reset below re-registers them from the runtime's hold.
    void ports.actions.submitNewDraft(key, intent, files)
    openPendingDraft(key)
  }, [openPendingDraft, ports, writeDraftThrough])

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
          } else {
            setSubmitError(result.outcome === 'request-rejected' ? result.code : 'network-failure')
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

  // The result cache's wire reads the live ports, so a reconnect re-crosses
  // through the new client instead of a closure-held dead one; creation is
  // deferred to call time because render-scope closures over refs are
  // forbidden (react-hooks/refs).
  const ensureResultBlobCache = useCallback((): ResultBlobCache => {
    if (resultBlobCacheRef.current === null) {
      resultBlobCacheRef.current = new ResultBlobCache(async (taskId, slotIndex) => {
        const currentPorts = portsRef.current
        if (currentPorts === null) return null
        const result = await currentPorts.loadResultBlob(taskId, slotIndex)
        return result.outcome === 'succeeded' ? result.value : null
      })
    }
    return resultBlobCacheRef.current
  }, [])

  const acquireResultBlobUrl = useCallback(
    (taskId: string, slotIndex: number) =>
      ensureResultBlobCache().acquireObjectUrl(taskId, slotIndex),
    [ensureResultBlobCache]
  )

  const loadMaterialPreviewBlob = useCallback(
    async (materialId: string, signal?: AbortSignal): Promise<Blob | null> => {
      const pending = pendingMaterialFilesRef.current.get(materialId)?.file
      if (pending !== undefined) return pending
      if (!ports) return null
      const result = await ports.loadMaterialBlob(materialId, signal)
      return result.outcome === 'succeeded' ? result.value : null
    },
    [ports]
  )

  const staleFields: ReadonlySet<DraftStaleField> = useMemo(
    () =>
      staleDraftFields(manifest, {
        ...draft
      }),
    [draft, manifest]
  )

  const mentionCandidates = useMemo(
    () => promptMentionCandidates(draft.references, materials, mentionKindLabels),
    [draft.references, materials, mentionKindLabels]
  )
  // The deck's replace aim must refuse cards the prompt still names through
  // Reference Mentions — replacing one is a removal under the hood.
  const mentionedMaterialIds = useMemo(() => {
    const mentioned = new Set<string>()
    for (const material of materials) {
      if (countPromptMentions(draft.promptDocument, material.id) > 0) mentioned.add(material.id)
    }
    return mentioned
  }, [draft.promptDocument, materials])
  const expandedPrompt = useMemo(
    () => expandPromptDocument(draft.promptDocument, mentionCandidates),
    [draft.promptDocument, mentionCandidates]
  )
  const promptLength = promptDocumentLength(draft.promptDocument, mentionCandidates)
  const currentCapability =
    draft.mediaType === null ? null : mediaCapability(manifest, draft.mediaType)
  const promptMinChars =
    currentCapability?.available === true ? (currentCapability.prompt?.minChars ?? 1) : 1
  const promptMaxChars =
    currentCapability?.available === true ? (currentCapability.prompt?.maxChars ?? 2000) : 2000
  const promptInvalid = promptLength < promptMinChars || promptLength > promptMaxChars

  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [selectedId, sessions]
  )
  const actionState = useMemo<WorkbenchActionState>(() => {
    void actionRevision
    const contextKey = pendingKey ?? selectedId
    return contextKey === null || ports === null
      ? { status: 'idle' }
      : ports.actions.snapshot(contextKey)
  }, [actionRevision, pendingKey, ports, selectedId])
  const actionBlocksSubmission =
    actionState.status === 'preparing' ||
    actionState.status === 'submitting' ||
    actionState.status === 'session-unconfirmed' ||
    actionState.status === 'submission-unconfirmed' ||
    actionState.status === 'material-unconfirmed' ||
    actionState.status === 'retired'

  const submitBlocked: 'unavailable' | 'stale' | 'length' | null = (() => {
    if (draft.mediaType === null || draft.model === null || draft.mode === null)
      return 'unavailable'
    // Submission freezes a manifest-conformant intent: without the current
    // manifest the client cannot vouch for the draft, so the command stays
    // inert (the server would reject it as stale or unavailable anyway).
    const capability = mediaCapability(manifest, draft.mediaType)
    if (manifestStatus !== 'ready' || capability === null || !capability.available) {
      return 'unavailable'
    }
    if (promptInvalid) return 'length'
    if (staleFields.size > 0) return 'stale'
    return null
  })()

  const deckCap = referenceCap(manifest, draft.mediaType ?? 'image', draft.model, draft.mode)
  const allowedKinds = allowedReferenceKinds(manifest, draft.mediaType, draft.mode)

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
        const remaining = Math.max(0, deckCap - draftRef.current.references.length)
        const plan = planFileDrop(files, allowedKinds, remaining)
        for (const file of plan.accepted) {
          await addMaterial(file)
          if (!mountedRef.current) return
        }
        const rejected = plan.rejectedKind + plan.rejectedCap
        if (rejected > 0) {
          setMaterialDropRejection({ added: plan.accepted.length, rejected })
        }
      })()
    },
    [addMaterial, allowedKinds, deckCap, ports]
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
        const draftNow = draftRef.current
        const position = draftNow.references.findIndex(
          (binding) => binding.materialId === materialId
        )
        const replaceable =
          materialIdsRef.current.has(materialId) &&
          position >= 0 &&
          countPromptMentions(draftNow.promptDocument, materialId) === 0
        if (!replaceable) {
          addMaterials([file])
          return
        }
        setMaterialUploadFailed(false)
        setMaterialDropRejection(null)
        const sessionIdAtStart = selectedIdRef.current
        const replacementId = crypto.randomUUID()
        const pendingReplacement = registerPendingMaterial(replacementId, file)
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
              selectedIdRef.current === sessionIdAtStart
            ) {
              forgetMaterialRecords(staged.id)
              dropPendingMaterial(staged.id)
            }
            return
          }
          if (!mountedRef.current || selectedIdRef.current !== sessionIdAtStart) return
          forgetMaterialRecords(staged.id)
          dropPendingMaterial(staged.id)
          replacement = { id: result.value.id, kind: result.value.kind }
          if (!materialIdsRef.current.has(result.value.id)) {
            materialsRef.current = [...materialsRef.current, result.value]
            materialIdsRef.current = new Set([...materialIdsRef.current, result.value.id])
            setMaterials((current) => [...current, result.value])
          }
        }
        if (sessionIdAtStart === null && pendingMaterialFilesRef.current.has(materialId)) {
          dropPendingMaterial(materialId)
        } else {
          materialUrlsRef.current?.releaseMaterial(materialId)
          dropPendingMaterial(materialId)
        }
        forgetMaterialRecords(materialId)
        // Merge into the latest Draft, not the click-time snapshot: prompt,
        // parameter, and other reference edits remain authoritative while
        // the runtime finishes the upload/delete action.
        const latestDraft = draftRef.current
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
      forgetMaterialRecords,
      patchDraft,
      ports,
      registerPendingMaterial
    ]
  )

  /**
   * A dragged result re-enters through the plain upload path (ADR-0018):
   * verified bytes stream back through the trusted data plane and upload
   * as a brand-new material named like its download twin.
   */
  const addResultAsMaterial = useCallback(
    (payload: ResultDragPayload, targetMaterialId: string | null): void => {
      if (!ports) return
      void (async () => {
        const blob = (await ensureResultBlobCache().blob(payload.taskId, payload.slotIndex)) ?? null
        if (!mountedRef.current) return
        if (blob === null) {
          setMaterialUploadFailed(true)
          return
        }
        const mimeType = blob.type !== '' ? blob.type : null
        const file = new File(
          [blob],
          resultFilename(payload.taskId, payload.slotIndex, payload.mediaType, mimeType),
          { type: blob.type }
        )
        if (targetMaterialId !== null) replaceMaterial(targetMaterialId, file)
        else addMaterials([file])
      })()
    },
    [addMaterials, ports, replaceMaterial, ensureResultBlobCache]
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

  return {
    ports,
    status,
    reload: (): void => setReloadAttempt((attempt) => attempt + 1),
    sessions,
    selected,
    selectedId,
    composingNew,
    pendingKey,
    pendingDrafts,
    openPendingDraft,
    selectSession: (session: CreationSessionView) => {
      void selectSession(session)
    },
    startNewDraft,
    deleteSession: (sessionId: string) => {
      void deleteSession(sessionId)
    },
    renameSession,
    materials,
    thumbnails,
    thumbnailStates,
    retainMaterialThumbnail,
    requestMaterialThumbnail,
    draft,
    mentionCandidates,
    expandedPrompt,
    promptLength,
    promptMaxChars,
    promptInvalid,
    patchDraft,
    setMediaType,
    setModel,
    setMode,
    addMaterial: (file: File) => {
      void addMaterial(file)
    },
    addMaterials,
    replaceMaterial,
    addResultAsMaterial,
    mentionedMaterialIds,
    materialDropRejection,
    removeMaterial: requestMaterialRemoval,
    pendingMaterialRemoval,
    confirmMaterialRemoval,
    dismissMaterialRemoval: () => setPendingMaterialRemoval(null),
    referenceRecoveryShown,
    dismissReferenceRecovery: () => setReferenceRecoveryShown(false),
    materialUploadFailed,
    manifest,
    manifestStatus,
    staleFields,
    deckCap,
    allowedKinds,
    tasks,
    taskDetails,
    taskDetailStaleIds: taskRefresh.snapshot.staleTaskIds,
    taskListStale: taskRefresh.snapshot.listFailed,
    submitDisabled: submitBlocked !== null || actionBlocksSubmission,
    submitBlockedReason: submitBlocked,
    submit: submitCallback,
    actionState,
    operationNotice,
    resumeSubmission: () => {
      const contextKey = displayedContextKey()
      if (contextKey !== null) void ports?.actions.resumeSubmission(contextKey)
    },
    stopTracking: () => {
      const contextKey = displayedContextKey()
      if (contextKey === null || !ports) return
      ports.actions.stopTracking(contextKey)
      operationNoticeRef.current = null
      setOperationNotice(null)
      setActionRevision((revision) => revision + 1)
      reconcileAction()
    },
    reconcileAction,
    cancelTask: cancelTaskById,
    retryTask: retryTaskById,
    submitError,
    dismissSubmitError: () => {
      const contextKey = displayedContextKey()
      if (contextKey !== null) ports?.actions.acknowledgeFailure(contextKey)
      setSubmitError(null)
    },
    acquireResultBlobUrl,
    loadMaterialPreviewBlob,
    requestIndeterminateRedo: (taskId: string) => setIndeterminateTaskId(taskId),
    confirmIndeterminateRedo,
    indeterminateTaskId,
    dismissIndeterminate: () => setIndeterminateTaskId(null)
  }
}
