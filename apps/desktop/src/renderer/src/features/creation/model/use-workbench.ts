import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CapabilityManifest } from '../api/capability-manifest-http'
import type {
  CreationSessionView,
  DraftReferenceView,
  ReferenceMaterialView,
  SessionDraftInput
} from '../api/go-creation-http'
import type { GenerationTaskDetail, GenerationTaskView } from '../api/generation-task-http'
import { isTerminalTaskStatus } from '../api/generation-task-http'
import {
  allowedReferenceKinds,
  mediaCapability,
  referenceCap,
  roleAcceptsKind,
  roleForPosition,
  staleDraftFields,
  type DraftMediaType,
  type DraftStaleField
} from './capability'
import { useCreationRuntime, type CreationRuntime } from './runtime-context'

export type WorkbenchStatus = 'loading' | 'ready' | 'error'

/** idle = nothing unsent; the other states describe the autosave pipeline. */
export type DraftSaveStatus = 'idle' | 'saving' | 'saved' | 'failed'

export type ManifestStatus = 'loading' | 'ready' | 'unavailable'

/**
 * The composer's editable mirror of the session draft. Field values are
 * exactly what the creator sees and what gets saved — the manifest only adds
 * candidate menus and stale verdicts, it never rewrites these values.
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

/** Debounce for draft autosave; short enough that a reload loses nothing. */
const autosaveDebounceMs = 800

/**
 * The Workbench orchestration (issue #177): private session list state, the
 * selected session's materials, the Capability Manifest, and the recoverable
 * draft with its autosave pipeline. Provider availability never gates editing
 * or saving — only the candidate menus and stale verdicts come from the
 * manifest.
 */
export interface CreationWorkbenchController {
  ports: CreationRuntime
  status: WorkbenchStatus
  reload: () => void
  sessions: readonly CreationSessionView[]
  selected: CreationSessionView | null
  selectedId: string | null
  selectSession: (session: CreationSessionView) => void
  createSession: (name: string) => void
  deleteSession: (sessionId: string) => void
  materials: readonly ReferenceMaterialView[]
  thumbnails: Readonly<Record<string, string>>
  draft: ComposerDraft
  patchDraft: (patch: Partial<ComposerDraft>) => void
  setMediaType: (media: DraftMediaType) => void
  setMode: (mode: string) => void
  addMaterial: (file: File) => void
  removeMaterial: (materialId: string) => void
  saveStatus: DraftSaveStatus
  retrySave: () => void
  manifest: CapabilityManifest | null
  manifestStatus: ManifestStatus
  staleFields: ReadonlySet<DraftStaleField>
  deckCap: ReturnType<typeof referenceCap>
  allowedKinds: ReturnType<typeof allowedReferenceKinds>
  tasks: readonly GenerationTaskView[]
  taskDetails: Readonly<Record<string, GenerationTaskDetail>>
  submitDisabled: boolean
  submitBlockedReason: 'unavailable' | 'stale' | 'saving' | null
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
  const [materials, setMaterials] = useState<readonly ReferenceMaterialView[]>([])
  const [thumbnails, setThumbnails] = useState<Readonly<Record<string, string>>>({})
  const [draft, setDraft] = useState<ComposerDraft>(emptyComposerDraft)
  const [saveStatus, setSaveStatus] = useState<DraftSaveStatus>('idle')
  const [manifest, setManifest] = useState<CapabilityManifest | null>(null)
  const [manifestStatus, setManifestStatus] = useState<ManifestStatus>('loading')
  const [tasks, setTasks] = useState<readonly GenerationTaskView[]>([])
  const [taskDetails, setTaskDetails] = useState<Readonly<Record<string, GenerationTaskDetail>>>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [indeterminateTaskId, setIndeterminateTaskId] = useState<string | null>(null)
  const [eventStreamLive, setEventStreamLive] = useState(false)
  const [invalidationTick, setInvalidationTick] = useState(0)
  // Render-visible submission facts: the revision a submit would echo (null
  // until a stored or freshly saved draft is authoritative) and whether a
  // submission round trip is in flight.
  const [draftRevision, setDraftRevision] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // The manifest version the composer last saw — the save payload records it
  // verbatim; with no manifest ever seen, the stored draft's version stands.
  // State rather than a ref because the stale verdicts derive from it in
  // render; the autosave callbacks read it through their fresh closures.
  const [seenManifestVersion, setSeenManifestVersion] = useState<number | null>(null)
  const baselineRef = useRef<string>(JSON.stringify(emptyComposerDraft()))
  const draftRef = useRef<ComposerDraft>(draft)
  const selectedIdRef = useRef<string | null>(selectedId)
  const draftRevisionRef = useRef<string | null>(null)
  const submittingRef = useRef(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(false)

  // Render cannot write refs; mirror the committed values after commit so the
  // autosave pipeline (timer, flush, unmount cleanup) always reads the latest
  // state without stale closures. Layout timing is load-bearing: the flush
  // effect below tears down in the same commit's passive-cleanup phase, which
  // runs BEFORE passive setups — a passive mirror there would let the flush
  // compare a one-render-stale draft against the new baseline and save it.
  useLayoutEffect(() => {
    draftRef.current = draft
    selectedIdRef.current = selectedId
  })

  useEffect(() => {
    // StrictMode's dev-only unmount/remount re-runs this effect while the ref
    // object persists, so liveness must be re-asserted on every run.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const isDirty = useCallback(() => JSON.stringify(draftRef.current) !== baselineRef.current, [])

  const toInput = useCallback(
    (value: ComposerDraft): SessionDraftInput => ({
      ...value,
      manifestVersion: seenManifestVersion ?? 1,
      updatedAt: draftRevisionRef.current ?? ''
    }),
    [seenManifestVersion]
  )

  const persistDraft = useCallback(
    async (sessionId: string, value: ComposerDraft) => {
      if (!ports) return
      setSaveStatus('saving')
      const result = await ports.saveSessionDraft(sessionId, toInput(value)).catch(() => null)
      if (!mountedRef.current) return
      // Only the still-selected session consumes the verdict; a save that
      // raced a session switch is already superseded by the switch's own load.
      if (selectedIdRef.current !== sessionId) return
      if (result !== null && result.outcome === 'succeeded') {
        baselineRef.current = JSON.stringify(value)
        draftRevisionRef.current = result.value.updatedAt
        setDraftRevision(result.value.updatedAt)
        setSaveStatus('saved')
      } else {
        setSaveStatus('failed')
      }
    },
    [ports, toInput]
  )

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      const sessionId = selectedIdRef.current
      if (sessionId !== null && isDirty()) void persistDraft(sessionId, draftRef.current)
    }, autosaveDebounceMs)
  }, [isDirty, persistDraft])

  /** Sends any pending draft now — session switch, material ops, unmount. */
  const flushSave = useCallback(async () => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const sessionId = selectedIdRef.current
    if (sessionId !== null && isDirty()) await persistDraft(sessionId, draftRef.current)
  }, [isDirty, persistDraft])

  const patchDraft = useCallback(
    (patch: Partial<ComposerDraft>) => {
      setDraft((current) => ({ ...current, ...patch }))
      setSaveStatus('idle')
      scheduleSave()
    },
    [scheduleSave]
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
    return {
      prompt: '',
      mediaType: media,
      model: capability.model ?? null,
      mode: first ? first.id : null,
      ratio: capability.defaults?.ratio ?? null,
      resolution: capability.defaults?.resolution ?? null,
      quantity: capability.defaults?.quantity ?? null,
      durationSeconds: capability.defaults?.duration ?? null,
      references: []
    }
  }, [])

  /** A brand-new draft adopts the manifest defaults exactly once. */
  const adoptManifestDefaults = useCallback(
    (value: CapabilityManifest) => {
      // Only an untouched empty draft is auto-configured; anything the
      // creator (or a stored draft) holds is never rewritten.
      if (JSON.stringify(draftRef.current) !== JSON.stringify(emptyComposerDraft())) return
      if (selectedIdRef.current === null) return
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

  // Flush an unsaved draft before the surface goes away. Reuses the same
  // dirty check and input mapping as the debounced pipeline; the save itself
  // is best-effort because the renderer is already tearing down.
  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
      const sessionId = selectedIdRef.current
      if (sessionId !== null && JSON.stringify(draftRef.current) !== baselineRef.current) {
        void ports?.saveSessionDraft(sessionId, toInput(draftRef.current))
      }
    },
    [ports, toInput]
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

  const applyLoadedDraft = useCallback((stored: ComposerDraft | null) => {
    const value = stored ?? emptyComposerDraft()
    baselineRef.current = JSON.stringify(value)
    setDraft(value)
    setSaveStatus('idle')
  }, [])

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
      await flushSave()
      setSelectedId(session.id)
      selectedIdRef.current = session.id
      setMaterials([])
      setThumbnails({})
      // Optimistic empty draft until the authoritative copy arrives.
      applyLoadedDraft(emptyComposerDraft())
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
        setStatus('error')
        setSelectedId(null)
        selectedIdRef.current = null
        return
      }
      setMaterials(materialPage.value.materials)
      const stored = detail.value.draft
      draftRevisionRef.current = stored?.updatedAt ?? null
      setDraftRevision(stored?.updatedAt ?? null)
      void loadTasks(session.id)
      applyLoadedDraft(
        stored === null
          ? // A never-saved session starts from the manifest defaults when the
            // manifest is available; nothing stored is ever rewritten.
            manifest === null
            ? null
            : manifestDefaultDraft(manifest)
          : {
              prompt: stored.prompt,
              mediaType: stored.mediaType,
              model: stored.model,
              mode: stored.mode,
              ratio: stored.ratio,
              resolution: stored.resolution,
              quantity: stored.quantity,
              durationSeconds: stored.durationSeconds,
              references: [...stored.references]
            }
      )
      if (stored !== null) {
        setSeenManifestVersion((previous) => previous ?? stored.manifestVersion)
      }
      await loadThumbnails(materialPage.value.materials)
    },
    [applyLoadedDraft, flushSave, loadTasks, loadThumbnails, manifest, manifestDefaultDraft, ports]
  )

  const setMediaType = useCallback(
    (media: DraftMediaType) => {
      if (!ports) return
      const capability = mediaCapability(manifest, media)
      const published = capability?.available ? capability : null
      patchDraft({
        mediaType: media,
        model: published?.model ?? null,
        mode: published ? ((published.modes ?? [])[0]?.id ?? null) : null,
        resolution: published?.defaults?.resolution ?? null,
        ratio: published?.defaults?.ratio ?? null,
        quantity: published?.defaults?.quantity ?? null,
        durationSeconds: published?.defaults?.duration ?? null
      })
    },
    [manifest, patchDraft, ports]
  )

  const setMode = useCallback(
    (mode: string) => {
      const media = draftRef.current.mediaType
      // Re-derive binding roles only for published modes; a stale mode keeps
      // every stored binding untouched. A binding whose material kind cannot
      // structurally fill the new role (the server twin is roleAcceptsKind)
      // keeps its previous role, so the draft stays saveable and the stale
      // reference note — never a silent rewrite — explains the mismatch.
      const kindOf = new Map(materials.map((material) => [material.id, material.kind] as const))
      const known = media !== null && roleForPosition(media, mode, 0) !== null
      const rederived = known
        ? draftRef.current.references.map((reference, position) => {
            const nextRole = roleForPosition(media, mode, position)
            const kind = kindOf.get(reference.materialId)
            if (nextRole === null || kind === undefined || !roleAcceptsKind(nextRole, kind)) {
              return reference
            }
            return { ...reference, role: nextRole }
          })
        : draftRef.current.references
      patchDraft({ mode, references: rederived })
    },
    [materials, patchDraft]
  )

  const createSession = useCallback(
    async (name: string) => {
      if (!ports) return
      const result = await ports.createSession(name.trim()).catch(() => null)
      if (!mountedRef.current) return
      if (result === null || result.outcome !== 'succeeded') {
        setStatus('error')
        return
      }
      setSessions((current) => [result.value, ...current])
      setStatus('ready')
      await selectSession(result.value)
    },
    [ports, selectSession]
  )

  const deleteSession = useCallback(
    async (sessionId: string) => {
      if (!ports) return
      if (selectedIdRef.current === sessionId) {
        // The draft of a deleted session must not be resurrected by a flush.
        if (saveTimerRef.current !== null) {
          clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
        }
        selectedIdRef.current = null
        setSelectedId(null)
        applyLoadedDraft(emptyComposerDraft())
      }
      setSessions((current) => current.filter((session) => session.id !== sessionId))
      await ports.deleteSession(sessionId).catch(() => undefined)
    },
    [applyLoadedDraft, ports]
  )

  const addMaterial = useCallback(
    async (file: File) => {
      const sessionId = selectedIdRef.current
      if (!ports || sessionId === null) return
      const result = await ports.uploadMaterial(sessionId, file).catch(() => null)
      if (!mountedRef.current) return
      if (result === null || result.outcome !== 'succeeded') {
        setSaveStatus('failed')
        return
      }
      const material = result.value
      setMaterials((current) => [...current, material])
      const media = draftRef.current.mediaType
      const derived =
        media === null
          ? null
          : roleForPosition(media, draftRef.current.mode, draftRef.current.references.length)
      // The structural fallback keeps every kind saveable: images take the
      // image role, anything else binds as omni (which accepts all kinds).
      const role = derived ?? (material.kind === 'image' ? 'reference' : 'omni')
      const binding: DraftReferenceView = { materialId: material.id, role }
      patchDraft({ references: [...draftRef.current.references, binding] })
      if (material.kind === 'image') {
        void ports
          .loadImageBlobUrl(material.id)
          .then((url) => {
            if (!url || !mountedRef.current) return
            setThumbnails((current) => ({ ...current, [material.id]: url }))
          })
          .catch(() => undefined)
      }
    },
    [patchDraft, ports]
  )

  const removeMaterial = useCallback(
    async (materialId: string) => {
      if (!ports) return
      patchDraft({
        references: draftRef.current.references.filter((entry) => entry.materialId !== materialId)
      })
      setMaterials((current) => current.filter((material) => material.id !== materialId))
      await ports.deleteMaterial(materialId).catch(() => undefined)
    },
    [patchDraft, ports]
  )

  const retrySave = useCallback(() => {
    const sessionId = selectedIdRef.current
    if (sessionId !== null) void persistDraft(sessionId, draftRef.current)
  }, [persistDraft])

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

  const submit = useCallback(() => {
    const sessionId = selectedIdRef.current
    const revision = draftRevisionRef.current
    if (!ports || sessionId === null || revision === null) return
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setSubmitError(null)
    const run = async (): Promise<void> => {
      // The submission freezes the SERVER-stored draft: flush any unsaved
      // edit first so the frozen intent is exactly what the composer shows.
      await flushSave()
      const result = await ports
        .submitTask(sessionId, {
          idempotencyKey: crypto.randomUUID(),
          draftRevision: draftRevisionRef.current ?? revision
        })
        .catch(() => null)
      submittingRef.current = false
      setSubmitting(false)
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
    }
    void run()
  }, [flushSave, loadTasks, ports])

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
        manifestVersion: seenManifestVersion ?? 1,
        updatedAt: ''
      }),
    [draft, manifest, seenManifestVersion]
  )

  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [selectedId, sessions]
  )

  const submitBlocked: 'unavailable' | 'stale' | 'saving' | null = (() => {
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
    if (saveStatus === 'saving' || saveStatus === 'failed') return 'saving'
    return null
  })()

  const deckCap = referenceCap(manifest, draft.mediaType ?? 'image', draft.mode)
  const allowedKinds = allowedReferenceKinds(manifest, draft.mediaType, draft.mode)

  return {
    ports,
    status,
    reload: (): void => setReloadAttempt((attempt) => attempt + 1),
    sessions,
    selected,
    selectedId,
    selectSession: (session: CreationSessionView) => {
      void selectSession(session)
    },
    createSession: (name: string) => {
      void createSession(name)
    },
    deleteSession: (sessionId: string) => {
      void deleteSession(sessionId)
    },
    materials,
    thumbnails,
    draft,
    patchDraft,
    setMediaType,
    setMode,
    addMaterial: (file: File) => {
      void addMaterial(file)
    },
    removeMaterial: (materialId: string) => {
      void removeMaterial(materialId)
    },
    saveStatus,
    retrySave,
    manifest,
    manifestStatus,
    staleFields,
    deckCap,
    allowedKinds,
    tasks,
    taskDetails,
    submitDisabled: submitBlocked !== null || draftRevision === null || submitting,
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
