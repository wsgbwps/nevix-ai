import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CapabilityManifest } from '../api/capability-manifest-http'
import type {
  CreationSessionView,
  DraftReferenceView,
  LocalDraftRecord,
  MaterialKind,
  ReferenceMaterialView
} from '../api/go-creation-http'
import type { GenerationTaskDetail, GenerationTaskView } from '../api/generation-task-http'
import { isTerminalTaskStatus } from '../api/generation-task-http'
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
import { readLocalDraft, removeLocalDraft, writeLocalDraft } from './draft-store'
import { useCreationRuntime, type CreationRuntime } from './runtime-context'

export type WorkbenchStatus = 'loading' | 'ready' | 'error'

export type ManifestStatus = 'loading' | 'ready' | 'unavailable'

/**
 * The composer's editable mirror of the session draft. Field values are
 * exactly what the creator sees; the manifest only adds candidate menus and
 * stale verdicts, it never rewrites these values.
 */
export interface ComposerDraft {
  prompt: string
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
  prompt: '',
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
  patchDraft: (patch: Partial<ComposerDraft>) => void
  setMediaType: (media: DraftMediaType) => void
  setModel: (model: string) => void
  setMode: (mode: string) => void
  addMaterial: (file: File) => void
  removeMaterial: (materialId: string) => void
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
  submitBlockedReason: 'unavailable' | 'stale' | null
  submit: () => void
  cancelTask: (taskId: string) => void
  retryTask: (taskId: string) => void
  submitError: string | null
  dismissSubmitError: () => void
  /** Streams one succeeded slot's verified output for display. */
  loadResultBlobUrl: (taskId: string, slotIndex: number) => Promise<string | null>
  /** Retry of indeterminate work requires the creator's explicit risk confirm. */
  requestIndeterminateRedo: (taskId: string) => void
  confirmIndeterminateRedo: (taskId: string) => void
  indeterminateTaskId: string | null
  dismissIndeterminate: () => void
}

export function useCreationWorkbench(): CreationWorkbenchController {
  const ports = useCreationRuntime()

  const [status, setStatus] = useState<WorkbenchStatus>('loading')
  const [sessions, setSessions] = useState<readonly CreationSessionView[]>([])
  const [reloadAttempt, setReloadAttempt] = useState(0)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [composingNew, setComposingNew] = useState(false)
  const [materials, setMaterials] = useState<readonly ReferenceMaterialView[]>([])
  const [thumbnails, setThumbnails] = useState<Readonly<Record<string, string>>>({})
  const [draft, setDraft] = useState<ComposerDraft>(emptyComposerDraft)
  const [materialUploadFailed, setMaterialUploadFailed] = useState(false)
  const [manifest, setManifest] = useState<CapabilityManifest | null>(null)
  const [manifestStatus, setManifestStatus] = useState<ManifestStatus>('loading')
  const [tasks, setTasks] = useState<readonly GenerationTaskView[]>([])
  const [taskDetails, setTaskDetails] = useState<Readonly<Record<string, GenerationTaskDetail>>>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [indeterminateTaskId, setIndeterminateTaskId] = useState<string | null>(null)
  const [eventStreamLive, setEventStreamLive] = useState(false)
  const [invalidationTick, setInvalidationTick] = useState(0)
  const [submitting, setSubmitting] = useState(false)

  // The manifest version the composer last saw — the version a submission
  // records. State drives stale verdicts in render; the ref below serves
  // callbacks that can run before React commits the corresponding state
  // update.
  const [seenManifestVersion, setSeenManifestVersion] = useState<number | null>(null)
  // Manifest adoption can schedule a write-through in the same turn as the
  // state update. The synchronous twin prevents that write from persisting
  // the previous render's fallback version.
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

  /** The version a persisted record/submission carries: what the composer
   * last saw, else the restored record's own, else the contract floor. */
  const intentManifestVersion = (): number =>
    seenManifestVersionRef.current ?? recordManifestVersionRef.current ?? 1

  /**
   * Files added while composing a session that does not exist yet, keyed by
   * their synthetic material id. They upload when the session materializes at
   * submit time; until then nothing about them ever reaches the server.
   */
  const pendingMaterialFilesRef = useRef(
    new Map<string, { file: File; previewUrl: string | null }>()
  )

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
    if (pending.previewUrl !== null) URL.revokeObjectURL(pending.previewUrl)
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
      const record: LocalDraftRecord = {
        ...value,
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
      prompt: '',
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
        setSeenManifestVersion(result.value.manifestVersion)
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

  // Locally-held composing previews never became server materials; their
  // object URLs die with the surface. The draft itself already lives in the
  // device-local store — every patch wrote through synchronously.
  useEffect(
    () => () => {
      for (const [, entry] of pendingMaterialFilesRef.current) {
        if (entry.previewUrl !== null) URL.revokeObjectURL(entry.previewUrl)
      }
    },
    []
  )

  const loadThumbnails = useCallback(
    async (list: readonly ReferenceMaterialView[]) => {
      if (!ports) return
      const entries = await Promise.all(
        list.map(async (material) =>
          material.kind === 'image'
            ? ([material.id, await ports.loadImageBlobUrl(material.id)] as const)
            : ([material.id, null] as const)
        )
      )
      if (!mountedRef.current) return
      const next: Record<string, string> = {}
      for (const [id, url] of entries) {
        if (url) next[id] = url
      }
      setThumbnails(next)
    },
    [ports]
  )

  const applyLoadedDraft = useCallback(
    (stored: ComposerDraft | null, manifestVersion: number | null) => {
      const value = stored ?? emptyComposerDraft()
      recordManifestVersionRef.current = manifestVersion
      setDraft(value)
      setMaterialUploadFailed(false)
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
      setComposingNew(false)
      composingNewRef.current = false
      for (const materialId of pendingMaterialFilesRef.current.keys())
        dropPendingMaterial(materialId)
      setSelectedId(session.id)
      selectedIdRef.current = session.id
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
        let value: ComposerDraft = {
          prompt: stored.prompt,
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
        if (seenManifestVersionRef.current === null) {
          seenManifestVersionRef.current = stored.manifestVersion
          setSeenManifestVersion(stored.manifestVersion)
        }
      }
      restoreInFlightRef.current = false
      await loadThumbnails(materialPage.value.materials)
    },
    [applyLoadedDraft, loadTasks, loadThumbnails, manifest, manifestDefaultDraft, ports]
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
    setComposingNew(true)
    composingNewRef.current = true
    setSelectedId(null)
    selectedIdRef.current = null
    for (const materialId of pendingMaterialFilesRef.current.keys()) {
      dropPendingMaterial(materialId)
    }
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
      applyLoadedDraft({ ...stored, references: [], mode }, stored.manifestVersion)
      if (seenManifestVersionRef.current === null) {
        seenManifestVersionRef.current = stored.manifestVersion
        setSeenManifestVersion(stored.manifestVersion)
      }
    }
    restoreInFlightRef.current = false
  }, [applyLoadedDraft, manifest, manifestDefaultDraft, ports])

  const deleteSession = useCallback(
    async (sessionId: string) => {
      if (!ports) return
      if (selectedIdRef.current === sessionId) {
        selectedIdRef.current = null
        setSelectedId(null)
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
      void ports
        ?.loadImageBlobUrl(materialId)
        .then((url) => {
          if (!url || !mountedRef.current) return
          setThumbnails((current) => ({ ...current, [materialId]: url }))
        })
        .catch(() => undefined)
    },
    [ports]
  )

  const addMaterial = useCallback(
    async (file: File) => {
      if (!ports) return
      setMaterialUploadFailed(false)
      // The structural fallback keeps every kind submittable: images take the
      // image role, anything else binds as omni (which accepts all kinds).
      const bindToDraft = (kind: MaterialKind, materialId: string): void => {
        const media = draftRef.current.mediaType
        const derived =
          media === null
            ? null
            : roleForPosition(media, draftRef.current.mode, draftRef.current.references.length)
        const role = derived ?? (kind === 'image' ? 'reference' : 'omni')
        const binding: DraftReferenceView = { materialId, role }
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
      }
      const sessionId = selectedIdRef.current
      if (sessionId === null) {
        // Composing a session that does not exist yet: the file stays local
        // and uploads when the session materializes at submit time.
        const id = crypto.randomUUID()
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null
        pendingMaterialFilesRef.current.set(id, { file, previewUrl })
        const material = pendingMaterialView(id, file)
        setMaterials((current) => [...current, material])
        if (previewUrl !== null) setThumbnails((current) => ({ ...current, [id]: previewUrl }))
        bindToDraft(material.kind, id)
        return
      }
      const result = await ports.uploadMaterial(sessionId, file).catch(() => null)
      if (!mountedRef.current) return
      if (result === null || result.outcome !== 'succeeded') {
        setMaterialUploadFailed(true)
        return
      }
      const material = result.value
      setMaterials((current) => [...current, material])
      bindToDraft(material.kind, material.id)
      if (material.kind === 'image') loadImageThumbnail(material.id)
    },
    [bindingsForMode, loadImageThumbnail, patchDraft, ports]
  )

  const removeMaterial = useCallback(
    async (materialId: string) => {
      if (!ports) return
      const remaining = draftRef.current.references.filter(
        (entry) => entry.materialId !== materialId
      )
      if (draftRef.current.mediaType === 'image') {
        // The deck's emptiness flips the derived image mode back: an empty
        // reference-image draft could never satisfy its own minimum.
        const mode = remaining.length > 0 ? 'reference-image' : 'text-to-image'
        patchDraft({ references: bindingsForMode('image', mode, remaining), mode })
      } else {
        patchDraft({ references: remaining })
      }
      setMaterials((current) => current.filter((material) => material.id !== materialId))
      // A locally-held composing file never reached the server; only its
      // local records die with the removal.
      if (pendingMaterialFilesRef.current.has(materialId)) {
        dropPendingMaterial(materialId)
        return
      }
      await ports.deleteMaterial(materialId).catch(() => undefined)
    },
    [bindingsForMode, patchDraft, ports]
  )

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
        draftRef.current = { ...draftRef.current, references }
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
        const result = await ports
          .submitTask(sessionId, {
            idempotencyKey: crypto.randomUUID(),
            intent: {
              ...draftRef.current,
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

  const staleFields: ReadonlySet<DraftStaleField> = useMemo(
    () =>
      staleDraftFields(manifest, {
        ...draft,
        manifestVersion: seenManifestVersion ?? 1
      }),
    [draft, manifest, seenManifestVersion]
  )

  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [selectedId, sessions]
  )

  const submitBlocked: 'unavailable' | 'stale' | null = (() => {
    if (draft.mediaType === null || draft.model === null || draft.mode === null)
      return 'unavailable'
    // Submission freezes a manifest-conformant intent: without the current
    // manifest the client cannot vouch for the draft, so the command stays
    // inert (the server would reject it as stale or unavailable anyway).
    const capability = mediaCapability(manifest, draft.mediaType)
    if (manifestStatus !== 'ready' || capability === null || !capability.available) {
      return 'unavailable'
    }
    if (staleFields.size > 0) return 'stale'
    return null
  })()

  const deckCap = referenceCap(manifest, draft.mediaType ?? 'image', draft.model, draft.mode)
  const allowedKinds = allowedReferenceKinds(manifest, draft.mediaType, draft.mode)

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
    patchDraft,
    setMediaType,
    setModel,
    setMode,
    addMaterial: (file: File) => {
      void addMaterial(file)
    },
    removeMaterial: (materialId: string) => {
      void removeMaterial(materialId)
    },
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
    requestIndeterminateRedo: (taskId: string) => setIndeterminateTaskId(taskId),
    confirmIndeterminateRedo,
    indeterminateTaskId,
    dismissIndeterminate: () => setIndeterminateTaskId(null)
  }
}
