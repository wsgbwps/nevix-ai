import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CapabilityManifest } from '../api/capability-manifest-http'
import type {
  CreationSessionView,
  DraftReferenceView,
  ReferenceMaterialView
} from '../api/go-creation-http'
import type { GenerationTaskDetail, GenerationTaskView } from '../api/generation-task-http'
import { isTerminalTaskStatus } from '../api/generation-task-http'
import { loadImageDimensions } from '../lib/image-dimensions'
import { MaterialUrlOwner } from '../lib/material-url-owner'
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
  readLocalDraft,
  removeLocalDraft,
  writeLocalDraft,
  type LocalDraftRecord
} from './draft-store'
import {
  countPromptMentions,
  expandPromptDocument,
  promptDocumentLength,
  promptMentionCandidates,
  prunePromptMentions,
  remapPromptMentions,
  removePromptMentions,
  textPromptDocument,
  type PromptDocument,
  type PromptMentionCandidate,
  type PromptMentionKindLabels
} from './prompt-document'
import { useCreationRuntime, type CreationRuntime } from './runtime-context'

export type WorkbenchStatus = 'loading' | 'ready' | 'error'

export type ManifestStatus = 'loading' | 'ready' | 'unavailable'

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
  selectSession: (session: CreationSessionView) => void
  startNewDraft: () => void
  deleteSession: (sessionId: string) => void
  renameSession: (sessionId: string, name: string) => void
  materials: readonly ReferenceMaterialView[]
  thumbnails: Readonly<Record<string, string>>
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
  submitDisabled: boolean
  submitBlockedReason: 'unavailable' | 'stale' | 'length' | null
  submit: () => void
  cancelTask: (taskId: string) => void
  retryTask: (taskId: string) => void
  submitError: string | null
  dismissSubmitError: () => void
  /** Streams one succeeded slot's verified output for display. */
  loadResultBlobUrl: (taskId: string, slotIndex: number) => Promise<string | null>
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
  const [materials, setMaterials] = useState<readonly ReferenceMaterialView[]>([])
  const [thumbnails, setThumbnails] = useState<Readonly<Record<string, string>>>({})
  const [draft, setDraft] = useState<ComposerDraft>(emptyComposerDraft)
  const [materialUploadFailed, setMaterialUploadFailed] = useState(false)
  const [materialDropRejection, setMaterialDropRejection] = useState<{
    readonly added: number
    readonly rejected: number
  } | null>(null)
  const [manifest, setManifest] = useState<CapabilityManifest | null>(null)
  const [manifestStatus, setManifestStatus] = useState<ManifestStatus>('loading')
  const [tasks, setTasks] = useState<readonly GenerationTaskView[]>([])
  const [taskDetails, setTaskDetails] = useState<Readonly<Record<string, GenerationTaskDetail>>>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [indeterminateTaskId, setIndeterminateTaskId] = useState<string | null>(null)
  const [eventStreamLive, setEventStreamLive] = useState(false)
  const [invalidationTick, setInvalidationTick] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [pendingMaterialRemoval, setPendingMaterialRemoval] = useState<{
    readonly materialId: string
    readonly mentionCount: number
  } | null>(null)
  const [referenceRecoveryShown, setReferenceRecoveryShown] = useState(false)

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
  const submittingRef = useRef(false)
  const mountedRef = useRef(false)
  const materialIdsRef = useRef<ReadonlySet<string>>(new Set())
  const materialsRef = useRef<readonly ReferenceMaterialView[]>([])
  const mentionKindLabelsRef = useRef<PromptMentionKindLabels>(mentionKindLabels)
  const thumbnailLoadRef = useRef(0)
  const materialUrlsRef = useRef<MaterialUrlOwner | null>(null)
  if (materialUrlsRef.current === null) materialUrlsRef.current = new MaterialUrlOwner()

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

  /** A locally-held file masquerades as a material so the deck and role
   * binding treat it identically; the fields the upload would establish stay
   * empty until the real record replaces it. */
  const pendingMaterialView = (id: string, file: File): ReferenceMaterialView => ({
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
  })

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
  }

  // Render cannot write refs; mirror the committed values after commit so
  // callbacks (write-through, submit, unmount cleanup) always read the latest
  // state without stale closures.
  useLayoutEffect(() => {
    draftRef.current = draft
    selectedIdRef.current = selectedId
    composingNewRef.current = composingNew
    materialsRef.current = materials
    materialIdsRef.current = new Set(materials.map((material) => material.id))
    mentionKindLabelsRef.current = mentionKindLabels
  })

  useEffect(() => {
    // StrictMode's dev-only unmount/remount re-runs this effect while the ref
    // object persists, so liveness must be re-asserted on every run.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  /** The device-local draft store: synchronous write-through, keyed by the
   * connected account and the composing surface (ADR-0017). */
  const writeDraftThrough = useCallback(
    (value: ComposerDraft): void => {
      if (ports === null) return
      const storage = globalThis.localStorage
      if (storage === undefined) return
      const key = composingNewRef.current ? 'new' : selectedIdRef.current
      if (key === null) return
      const candidates = promptMentionCandidates(
        value.references,
        materialsRef.current,
        mentionKindLabelsRef.current
      )
      const record: LocalDraftRecord = {
        ...value,
        prompt: expandPromptDocument(value.promptDocument, candidates),
        manifestVersion: intentManifestVersion()
      }
      writeLocalDraft(storage, ports.userId, key, record)
    },
    [ports]
  )

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

  // The Feature-local owner revokes thumbnails and pending-file previews when
  // this surface ends.
  useEffect(
    () => () => {
      thumbnailLoadRef.current += 1
      materialUrlsRef.current?.dispose()
    },
    []
  )

  const loadThumbnails = useCallback(
    async (list: readonly ReferenceMaterialView[]) => {
      if (!ports) return
      const load = ++thumbnailLoadRef.current
      const entries = await Promise.all(
        list.map(async (material) =>
          material.kind === 'image'
            ? ([material.id, await ports.loadMaterialBlob(material.id)] as const)
            : ([material.id, null] as const)
        )
      )
      if (!mountedRef.current || load !== thumbnailLoadRef.current) return
      materialUrlsRef.current?.releaseThumbnails()
      const next: Record<string, string> = {}
      for (const [id, blob] of entries) {
        if (blob) next[id] = materialUrlsRef.current!.replaceThumbnail(id, blob)
      }
      setThumbnails(next)
    },
    [ports]
  )

  const applyLoadedDraft = useCallback(
    (stored: ComposerDraft | null, manifestVersion: number | null) => {
      const value = stored ?? emptyComposerDraft()
      recordManifestVersionRef.current = manifestVersion
      draftRef.current = value
      setDraft(value)
      setMaterialUploadFailed(false)
      // A surface switch must not carry the previous surface's drop summary.
      setMaterialDropRejection(null)
    },
    []
  )

  // --- Generation Task kernel (issue #159) ---------------------------------

  const loadTasks = useCallback(
    async (sessionId: string) => {
      if (!ports) return
      const result = await ports.listTasks(sessionId).catch(() => null)
      if (!mountedRef.current) return
      if (selectedIdRef.current !== sessionId) return
      if (result !== null && result.outcome === 'succeeded') {
        setTasks(result.value.tasks)
        const page = result.value.tasks
        const details: Record<string, GenerationTaskDetail> = {}
        await Promise.all(
          page.map(async (task) => {
            const detail = await ports.getTask(task.id).catch(() => null)
            if (detail !== null && detail.outcome === 'succeeded') {
              details[task.id] = detail.value
            }
          })
        )
        if (!mountedRef.current || selectedIdRef.current !== sessionId) return
        setTaskDetails(details)
      } else {
        setTasks([])
      }
    },
    [ports]
  )

  const refreshTasks = useCallback(() => {
    const sessionId = selectedIdRef.current
    if (sessionId !== null) void loadTasks(sessionId)
  }, [loadTasks])

  const selectSession = useCallback(
    async (session: CreationSessionView) => {
      if (!ports) return
      setReferenceRecoveryShown(false)
      setPendingMaterialRemoval(null)
      setComposingNew(false)
      composingNewRef.current = false
      for (const materialId of pendingMaterialFilesRef.current.keys())
        dropPendingMaterial(materialId)
      thumbnailLoadRef.current += 1
      materialUrlsRef.current?.dispose()
      setSelectedId(session.id)
      selectedIdRef.current = session.id
      materialsRef.current = []
      setMaterials([])
      setThumbnails({})
      // Optimistic empty draft and task view until the authoritative copies
      // arrive; stale entries must not leak across the switch. The restore
      // flag keeps manifest adoption from seeding this transient empty.
      restoreInFlightRef.current = true
      applyLoadedDraft(null, null)
      setTasks([])
      setTaskDetails({})
      const [detail, materialPage] = await Promise.all([
        ports.getSessionDetail(session.id).catch(() => null),
        ports.listMaterials(session.id).catch(() => null)
      ])
      if (!mountedRef.current) return
      if (
        detail === null ||
        detail.outcome !== 'succeeded' ||
        materialPage === null ||
        materialPage.outcome !== 'succeeded'
      ) {
        restoreInFlightRef.current = false
        setStatus('error')
        setSelectedId(null)
        selectedIdRef.current = null
        return
      }
      setMaterials(materialPage.value.materials)
      materialsRef.current = materialPage.value.materials
      materialIdsRef.current = new Set(materialPage.value.materials.map((material) => material.id))
      void loadTasks(session.id)
      // The editable draft is device-local state: restore this device's copy
      // and prune reference bindings whose materials no longer exist in the
      // session (deleted from another surface — nothing rewrote them here).
      const stored = readLocalDraft(globalThis.localStorage, ports.userId, session.id)
      if (stored === null) {
        applyLoadedDraft(manifest === null ? null : manifestDefaultDraft(manifest), null)
      } else {
        const known = new Set(materialPage.value.materials.map((material) => material.id))
        const references = stored.references.filter((reference) => known.has(reference.materialId))
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
        applyLoadedDraft(value, stored.manifestVersion)
        writeDraftThrough(value)
        if (seenManifestVersionRef.current === null) {
          seenManifestVersionRef.current = stored.manifestVersion
        }
      }
      restoreInFlightRef.current = false
      await loadThumbnails(materialPage.value.materials)
    },
    [
      applyLoadedDraft,
      loadTasks,
      loadThumbnails,
      manifest,
      manifestDefaultDraft,
      ports,
      writeDraftThrough
    ]
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
    setReferenceRecoveryShown(false)
    setPendingMaterialRemoval(null)
    setComposingNew(true)
    composingNewRef.current = true
    setSelectedId(null)
    selectedIdRef.current = null
    for (const materialId of pendingMaterialFilesRef.current.keys()) {
      dropPendingMaterial(materialId)
    }
    thumbnailLoadRef.current += 1
    materialUrlsRef.current?.dispose()
    materialsRef.current = []
    setMaterials([])
    setThumbnails({})
    setTasks([])
    setTaskDetails({})
    // startNewDraft resolves synchronously, but the same adoption guard as
    // selectSession keeps a manifest response landing mid-reset from seeding.
    restoreInFlightRef.current = true
    const storage = globalThis.localStorage
    const stored = storage === undefined ? null : readLocalDraft(storage, ports.userId, 'new')
    if (stored === null) {
      applyLoadedDraft(manifest === null ? null : manifestDefaultDraft(manifest), null)
    } else {
      // Pending files cannot survive a restart; their bindings die with them,
      // and an emptied reference-image deck flips its derived mode back so the
      // draft can still satisfy its own minimum.
      const mode =
        stored.mediaType === 'image' && stored.mode === 'reference-image'
          ? 'text-to-image'
          : stored.mode
      const prunedPromptDocument = prunePromptMentions(stored.promptDocument, [])
      const recovered =
        stored.references.length > 0 ||
        JSON.stringify(prunedPromptDocument) !== JSON.stringify(stored.promptDocument)
      // Pending files cannot survive a reload, but their last expanded prompt
      // can. Preserve that text rather than erasing mention-only drafts.
      const promptDocument = recovered ? textPromptDocument(stored.prompt) : prunedPromptDocument
      if (recovered) setReferenceRecoveryShown(true)
      const value = {
        promptDocument,
        mediaType: stored.mediaType,
        model: stored.model,
        mode,
        ratio: stored.ratio,
        resolution: stored.resolution,
        quantity: stored.quantity,
        durationSeconds: stored.durationSeconds,
        references: []
      }
      applyLoadedDraft(value, stored.manifestVersion)
      writeDraftThrough(value)
      if (seenManifestVersionRef.current === null) {
        seenManifestVersionRef.current = stored.manifestVersion
      }
    }
    restoreInFlightRef.current = false
  }, [applyLoadedDraft, manifest, manifestDefaultDraft, ports, writeDraftThrough])

  const deleteSession = useCallback(
    async (sessionId: string) => {
      if (!ports) return
      if (selectedIdRef.current === sessionId) {
        setReferenceRecoveryShown(false)
        setPendingMaterialRemoval(null)
        selectedIdRef.current = null
        setSelectedId(null)
        thumbnailLoadRef.current += 1
        materialUrlsRef.current?.dispose()
        materialsRef.current = []
        materialIdsRef.current = new Set()
        setMaterials([])
        setThumbnails({})
        applyLoadedDraft(null, null)
      }
      setSessions((current) => current.filter((session) => session.id !== sessionId))
      // The deleted session's device-local draft goes with it.
      const storage = globalThis.localStorage
      if (storage !== undefined) removeLocalDraft(storage, ports.userId, sessionId)
      await ports.deleteSession(sessionId).catch(() => undefined)
    },
    [applyLoadedDraft, ports]
  )

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

  const loadImageThumbnail = useCallback(
    (materialId: string): void => {
      const load = thumbnailLoadRef.current
      void ports
        ?.loadMaterialBlob(materialId)
        .then((blob) => {
          if (
            !blob ||
            !mountedRef.current ||
            load !== thumbnailLoadRef.current ||
            !materialIdsRef.current.has(materialId)
          ) {
            return
          }
          const url = materialUrlsRef.current!.replaceThumbnail(materialId, blob)
          setThumbnails((current) => ({ ...current, [materialId]: url }))
        })
        .catch(() => undefined)
    },
    [ports]
  )

  /**
   * Registers one file as a deck material and returns its identity: while
   * composing a session that does not exist yet the file stays local
   * (ADR-0017) and uploads at submit time; otherwise it uploads now. Returns
   * null when the upload fails (already surfaced as materialUploadFailed).
   */
  const stageMaterialFile = useCallback(
    async (file: File): Promise<{ id: string; kind: ReferenceMaterialView['kind'] } | null> => {
      if (!ports) return null
      const sessionId = selectedIdRef.current
      if (sessionId === null) {
        const id = crypto.randomUUID()
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
        return { id, kind: material.kind }
      }
      const result = await ports.uploadMaterial(sessionId, file).catch(() => null)
      if (!mountedRef.current) return null
      if (result === null || result.outcome !== 'succeeded') {
        setMaterialUploadFailed(true)
        return null
      }
      const material = result.value
      materialsRef.current = [...materialsRef.current, material]
      materialIdsRef.current = new Set([...materialIdsRef.current, material.id])
      setMaterials((current) => [...current, material])
      if (material.kind === 'image') loadImageThumbnail(material.id)
      return { id: material.id, kind: material.kind }
    },
    [loadImageThumbnail, ports]
  )

  /** Drops one material from every local record; the caller settles its
   * bytes (pending file vs server delete) around this. */
  const forgetMaterialRecords = useCallback((materialId: string): void => {
    setMaterials((current) => current.filter((material) => material.id !== materialId))
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
      const staged = await stageMaterialFile(file)
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
      // A locally-held composing file never reached the server; only its
      // local records die with the removal.
      if (pendingMaterialFilesRef.current.has(materialId)) {
        dropPendingMaterial(materialId)
        return
      }
      await ports.deleteMaterial(materialId).catch(() => undefined)
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

  // SSE invalidation after every persisted task change; while the stream is
  // down, polling converges the view within the ten-second contract window.
  useEffect(() => {
    if (!ports) return
    const unsubscribe = ports.subscribeEvents({
      onInvalidation: () => {
        setInvalidationTick((tick) => tick + 1)
      },
      onStateChange: setEventStreamLive
    })
    return unsubscribe
  }, [ports])

  useEffect(() => {
    if (invalidationTick > 0) refreshTasks()
  }, [invalidationTick, refreshTasks])

  const hasActiveTasks = useMemo(
    () => tasks.some((task) => !isTerminalTaskStatus(task.status)),
    [tasks]
  )

  useEffect(() => {
    if (eventStreamLive || !hasActiveTasks) return
    const interval = setInterval(refreshTasks, 5000)
    return () => clearInterval(interval)
  }, [eventStreamLive, hasActiveTasks, refreshTasks])

  /**
   * Creates the server session a composing round has been drafting against
   * and adopts it as selected WITHOUT reloading the stored state — the local
   * draft is the intent the submission carries. The draft is written under
   * the session's key BEFORE the composing key dies, so a mid-submit failure
   * or crash leaves the intent durable exactly once.
   */
  const materializeSession = useCallback(async (): Promise<string | null> => {
    if (!ports) return null
    const result = await ports.createSession('').catch(() => null)
    if (!mountedRef.current) return null
    if (result === null || result.outcome !== 'succeeded') {
      setSubmitError('network-failure')
      return null
    }
    const session = result.value
    setSessions((current) => [session, ...current])
    setComposingNew(false)
    composingNewRef.current = false
    setSelectedId(session.id)
    selectedIdRef.current = session.id
    writeDraftThrough(draftRef.current)
    const storage = globalThis.localStorage
    if (storage !== undefined) removeLocalDraft(storage, ports.userId, 'new')
    return session.id
  }, [ports, writeDraftThrough])

  /**
   * Uploads every locally-held composing file to the materialized session
   * and rewrites the draft bindings to the real material ids, preserving
   * order and roles. Already-uploaded files never send twice, so a retry
   * after a mid-way failure resumes with the rest.
   */
  const uploadPendingMaterials = useCallback(
    async (sessionId: string): Promise<boolean> => {
      if (!ports) return false
      const idMap = new Map<string, string>()
      let failed = false
      for (const [pendingId, entry] of pendingMaterialFilesRef.current) {
        const result = await ports.uploadMaterial(sessionId, entry.file).catch(() => null)
        if (!mountedRef.current) return false
        if (result === null || result.outcome !== 'succeeded') {
          setSubmitError('network-failure')
          failed = true
          break
        }
        idMap.set(pendingId, result.value.id)
        const uploaded = result.value
        materialsRef.current = materialsRef.current.map((material) =>
          material.id === pendingId ? uploaded : material
        )
        materialIdsRef.current = new Set(
          [...materialIdsRef.current].map((materialId) =>
            materialId === pendingId ? uploaded.id : materialId
          )
        )
        setMaterials((current) =>
          current.map((material) => (material.id === pendingId ? uploaded : material))
        )
        if (uploaded.kind === 'image') loadImageThumbnail(uploaded.id)
      }
      if (idMap.size > 0) {
        // Rewrite synchronously in state AND ref: the write-through that
        // follows must persist real material ids regardless of React commit
        // timing.
        const references = draftRef.current.references.map((reference) => {
          const realId = idMap.get(reference.materialId)
          return realId === undefined ? reference : { ...reference, materialId: realId }
        })
        draftRef.current = {
          ...draftRef.current,
          promptDocument: remapPromptMentions(draftRef.current.promptDocument, idMap),
          references
        }
        setDraft(draftRef.current)
        writeDraftThrough(draftRef.current)
        for (const pendingId of idMap.keys()) dropPendingMaterial(pendingId)
      }
      return !failed
    },
    [loadImageThumbnail, ports, writeDraftThrough]
  )

  const submit = useCallback(() => {
    if (!ports) return
    const currentSessionId = selectedIdRef.current
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setSubmitError(null)
    const finish = (): void => {
      submittingRef.current = false
      setSubmitting(false)
    }
    const run = async (): Promise<void> => {
      try {
        let sessionId = currentSessionId
        if (sessionId === null) {
          const created = await materializeSession()
          if (created === null) return
          sessionId = created
        }
        if (!(await uploadPendingMaterials(sessionId))) return
        // The submission carries the complete local intent (ADR-0017); the
        // write-through keeps this session's device-local copy identical to
        // what was frozen.
        writeDraftThrough(draftRef.current)
        const { promptDocument, ...plainIntent } = draftRef.current
        const candidates = promptMentionCandidates(
          draftRef.current.references,
          materialsRef.current,
          mentionKindLabelsRef.current
        )
        const result = await ports
          .submitTask(sessionId, {
            idempotencyKey: crypto.randomUUID(),
            intent: {
              ...plainIntent,
              prompt: expandPromptDocument(promptDocument, candidates),
              manifestVersion: intentManifestVersion()
            }
          })
          .catch(() => null)
        finish()
        if (!mountedRef.current) return
        if (selectedIdRef.current !== sessionId) return
        if (result !== null && result.outcome === 'succeeded') {
          setSubmitError(null)
          setIndeterminateTaskId(null)
          await loadTasks(sessionId)
        } else if (result !== null && result.outcome === 'request-rejected') {
          setSubmitError(result.code)
        } else {
          setSubmitError('network-failure')
        }
      } finally {
        finish()
      }
    }
    void run()
  }, [loadTasks, materializeSession, ports, uploadPendingMaterials, writeDraftThrough])

  // The composer's submit affordance: a void adapter so the JSX handler can
  // stay a plain reference.
  const submitCallback = useCallback(() => {
    submit()
  }, [submit])

  const cancelTaskById = useCallback(
    (taskId: string) => {
      void ports
        ?.cancelTask(taskId)
        .then(() => refreshTasks())
        .catch(() => undefined)
    },
    [ports, refreshTasks]
  )

  const retryTaskById = useCallback(
    (taskId: string) => {
      void ports
        ?.retryTask(taskId, crypto.randomUUID())
        .then((result) => {
          if (result.outcome === 'succeeded') {
            setIndeterminateTaskId(null)
            refreshTasks()
          } else {
            setSubmitError(result.outcome === 'request-rejected' ? result.code : 'network-failure')
          }
        })
        .catch(() => undefined)
    },
    [ports, refreshTasks]
  )

  const confirmIndeterminateRedo = useCallback(
    (taskId: string) => retryTaskById(taskId),
    [retryTaskById]
  )

  const loadResultBlobUrlFor = useCallback(
    (taskId: string, slotIndex: number) =>
      ports?.loadResultBlobUrl(taskId, slotIndex) ?? Promise.resolve(null),
    [ports]
  )

  const loadMaterialPreviewBlob = useCallback(
    async (materialId: string, signal?: AbortSignal): Promise<Blob | null> => {
      const pending = pendingMaterialFilesRef.current.get(materialId)?.file
      return pending ?? (await ports?.loadMaterialBlob(materialId, signal)) ?? null
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
        const media = draftNow.mediaType
        const staged = await stageMaterialFile(file)
        // A failed staging leaves the deck untouched; the old card only
        // retires once its replacement exists.
        if (staged === null) return
        if (pendingMaterialFilesRef.current.has(materialId)) {
          dropPendingMaterial(materialId)
        } else {
          materialUrlsRef.current?.releaseMaterial(materialId)
          await ports.deleteMaterial(materialId).catch(() => undefined)
        }
        forgetMaterialRecords(materialId)
        setThumbnails((current) => {
          if (!(materialId in current)) return current
          const next = { ...current }
          delete next[materialId]
          return next
        })
        // Splice the new binding into the replaced position; its role derives
        // from the mode exactly as a fresh add at that position would.
        const kept = draftRef.current.references.filter(
          (binding) => binding.materialId !== materialId
        )
        const insertAt = Math.min(position, kept.length)
        const fallbackRole = staged.kind === 'image' ? 'reference' : 'omni'
        const role =
          (media !== null ? roleForPosition(media, draftRef.current.mode, insertAt) : null) ??
          fallbackRole
        kept.splice(insertAt, 0, { materialId: staged.id, role })
        if (media === 'image') {
          patchDraft({
            references: bindingsForMode('image', 'reference-image', kept),
            mode: 'reference-image'
          })
        } else {
          patchDraft({ references: kept })
        }
      })()
    },
    [addMaterials, bindingsForMode, forgetMaterialRecords, patchDraft, ports, stageMaterialFile]
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
        const blob = await ports.loadResultBlob(payload.taskId, payload.slotIndex).catch(() => null)
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
    [addMaterials, ports, replaceMaterial]
  )

  return {
    ports,
    status,
    reload: (): void => setReloadAttempt((attempt) => attempt + 1),
    sessions,
    selected,
    selectedId,
    composingNew,
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
    submitDisabled: submitBlocked !== null || submitting,
    submitBlockedReason: submitBlocked,
    submit: submitCallback,
    cancelTask: cancelTaskById,
    retryTask: retryTaskById,
    submitError,
    dismissSubmitError: () => setSubmitError(null),
    loadResultBlobUrl: loadResultBlobUrlFor,
    loadMaterialPreviewBlob,
    requestIndeterminateRedo: (taskId: string) => setIndeterminateTaskId(taskId),
    confirmIndeterminateRedo,
    indeterminateTaskId,
    dismissIndeterminate: () => setIndeterminateTaskId(null)
  }
}
