/**
 * The Workbench Context controller (issue #206): the single owner of the
 * context the Creation Workbench is presenting — an existing Creation
 * Session, a device-local pending draft, a fresh composing start, or the
 * blank inactive state — together with the session list and the one
 * switching ritual every entry goes through (display reset, task-refresh
 * leave/enter, draft restore, staged file re-registration). Ritual variants
 * derive from the target context kind; callers never pass mode flags.
 *
 * Framework-free so the concurrency invariants are testable by driving the
 * public interface against scripted deps: the generation token that
 * invalidates every in-flight read, the explicit manifest adoption
 * invariant, disappearance diffing on list replacement, and submitError
 * derived from the current context's action snapshot.
 */
import type { CapabilityManifest } from '../api/capability-manifest-http'
import type {
  CreationApiResult,
  CreationSessionView,
  DraftReferenceView,
  MaterialPage,
  ReferenceMaterialView,
  SessionDetailView,
  SessionPage
} from '../api/go-creation-http'
import { mediaCapability, type DraftMediaType } from './capability'
import {
  readLocalDraft,
  removeLocalDraft,
  writeLocalDraft,
  type LocalDraftOperationNotice,
  type LocalDraftRecord
} from './draft-store'
import {
  expandPromptDocument,
  promptMentionCandidates,
  prunePromptMentions,
  textPromptDocument,
  type PromptDocument,
  type PromptMentionKindLabels
} from './prompt-document'
import type {
  CreationRuntimeEvent,
  StagedMaterialFile,
  WorkbenchActionState
} from './workbench-runtime'
import type { PendingMaterialFile } from './workbench-display-controller'

export type WorkbenchStatus = 'loading' | 'ready' | 'error'

/** The context the Workbench presents; `inactive` is the blank state no
 * session, pending draft, or composition is bound to. */
export type WorkbenchContextKey =
  | { readonly kind: 'session'; readonly session: CreationSessionView }
  | { readonly kind: 'pending'; readonly key: string }
  | { readonly kind: 'new' }
  | { readonly kind: 'inactive' }

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

/** The display-resource seam the switching ritual drives: the one
 * context-switch reset plus the staged-file reconciliation reads. */
export interface WorkbenchContextDisplaySeam {
  reset(): void
  replaceMaterials(views: readonly ReferenceMaterialView[]): void
  registerPending(id: string, file: File): ReferenceMaterialView
  dropPending(materialId: string): void
  transferPending(localId: string, resolvedId: string): void
  pendingFiles(): ReadonlyMap<string, PendingMaterialFile>
  getSnapshot(): { readonly materials: readonly ReferenceMaterialView[] }
}

/** The Generation Task refresh module's lifecycle handle (ADR-0005). */
export interface WorkbenchContextTasksSeam {
  enter(sessionId: string): void
  leave(): void
  requestReconcile(): void
}

/** The runtime action seam this module reads; every other command stays
 * with the workbench hook. */
export interface WorkbenchContextActionsSeam {
  snapshot(key: string): WorkbenchActionState
  stagedMaterials(key: string): readonly StagedMaterialFile[]
  resolvedMaterialId(sessionId: string, localId: string): string | null
  deleteSession(sessionId: string): Promise<CreationApiResult<void>>
  acknowledgeFailure(key: string): void
}

/** The read and orchestration seams this module consumes; no submit,
 * cancel, or retry crosses them. */
export interface WorkbenchContextDeps {
  readonly userId: string
  readonly listSessions: (cursor?: string | null) => Promise<CreationApiResult<SessionPage>>
  readonly renameSession: (
    sessionId: string,
    name: string
  ) => Promise<CreationApiResult<CreationSessionView>>
  readonly getSessionDetail: (sessionId: string) => Promise<CreationApiResult<SessionDetailView>>
  readonly listMaterials: (
    sessionId: string,
    cursor?: string | null
  ) => Promise<CreationApiResult<MaterialPage>>
  readonly actions: WorkbenchContextActionsSeam
  readonly display: WorkbenchContextDisplaySeam
  readonly tasks: WorkbenchContextTasksSeam
}

export interface WorkbenchContextSnapshot {
  readonly status: WorkbenchStatus
  readonly sessions: readonly CreationSessionView[]
  readonly selected: CreationSessionView | null
  readonly selectedId: string | null
  readonly composingNew: boolean
  readonly pendingKey: string | null
  /** The authoritative context key; every consumer-side key derives from it. */
  readonly contextKey: string
  /** The current context's runtime action key; `new` and `inactive` own no
   * runtime action of their own. */
  readonly actionKey: string | null
  readonly draft: ComposerDraft
  readonly actionState: WorkbenchActionState
  /** Derived from the current context's action snapshot; never a stale
   * error carried across a context switch. */
  readonly submitError: string | null
  readonly operationNotice: LocalDraftOperationNotice | null
  readonly referenceRecoveryShown: boolean
  readonly pendingMaterialRemoval: {
    readonly materialId: string
    readonly mentionCount: number
  } | null
  readonly materialUploadFailed: boolean
  readonly materialDropRejection: { readonly added: number; readonly rejected: number } | null
}

export const emptyWorkbenchContextSnapshot: WorkbenchContextSnapshot = {
  status: 'loading',
  sessions: [],
  selected: null,
  selectedId: null,
  composingNew: false,
  pendingKey: null,
  contextKey: 'inactive',
  actionKey: null,
  draft: emptyComposerDraft(),
  actionState: { status: 'idle' },
  submitError: null,
  operationNotice: null,
  referenceRecoveryShown: false,
  pendingMaterialRemoval: null,
  materialUploadFailed: false,
  materialDropRejection: null
}

interface WorkbenchContextOptions {
  readonly storage?: Storage
}

/** The runtime action events the current context reacts to; both carry the
 * action key they belong to. */
type ContextActionEvent = Extract<CreationRuntimeEvent, { type: 'changed' | 'reconcile' }>

/** The manifest-seeded draft a brand-new empty context starts from. */
function manifestDefaultDraft(value: CapabilityManifest): ComposerDraft | null {
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
}

/** Placeholder until the binding syncs the localized labels; no draft
 * persistence can run before that first effect. */
const defaultMentionLabels: PromptMentionKindLabels = {
  image: 'image',
  video: 'video',
  audio: 'audio'
}

export class WorkbenchContextController {
  readonly #deps: WorkbenchContextDeps
  readonly #storage: Storage | undefined
  readonly #listeners = new Set<() => void>()
  #active = false
  // The generation token — the only in-flight read invalidation mechanism.
  // Every context transition and every lifecycle suspend bumps it; restore
  // reads and list loads carry the epoch they started under and are
  // discarded when it no longer matches.
  #epoch = 0
  // Open from a context switch's optimistic reset until its record (or the
  // fallback) lands; #adoptManifestDefaults owns why adoption must wait.
  #restoreWindow = false
  #status: WorkbenchStatus = 'loading'
  #sessions: readonly CreationSessionView[] = []
  #selectedId: string | null = null
  #composingNew = false
  #pendingKey: string | null = null
  #draft: ComposerDraft = emptyComposerDraft()
  #operationNotice: LocalDraftOperationNotice | null = null
  #manifest: CapabilityManifest | null = null
  #seenManifestVersion: number | null = null
  #recordManifestVersion: number | null = null
  #mentionLabels: PromptMentionKindLabels = defaultMentionLabels
  #actionState: WorkbenchActionState = { status: 'idle' }
  #submitError: string | null = null
  #referenceRecoveryShown = false
  #pendingMaterialRemoval: WorkbenchContextSnapshot['pendingMaterialRemoval'] = null
  #materialUploadFailed = false
  #materialDropRejection: WorkbenchContextSnapshot['materialDropRejection'] = null
  #snapshot: WorkbenchContextSnapshot = emptyWorkbenchContextSnapshot

  constructor(deps: WorkbenchContextDeps, options: WorkbenchContextOptions = {}) {
    this.#deps = deps
    this.#storage =
      options.storage ??
      (typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage)
  }

  /** Re-asserts liveness and loads the session list; StrictMode's effect
   * replay re-runs this on the same instance after suspend retired the
   * first lifecycle's reads. */
  activate(): void {
    this.#active = true
    void this.#loadSessions()
  }

  suspend(): void {
    this.#active = false
    this.#epoch += 1
  }

  subscribe(notify: () => void): () => void {
    this.#listeners.add(notify)
    return () => {
      this.#listeners.delete(notify)
    }
  }

  getSnapshot(): WorkbenchContextSnapshot {
    return this.#snapshot
  }

  /**
   * The one switching ritual. The transition table derives from the target
   * kind: `session` restores asynchronously then merges server facts and
   * reconciles staged files; `pending` and `new` restore synchronously from
   * the device-local record (or seed defaults); `inactive` keeps nothing.
   */
  enterContext(key: WorkbenchContextKey): void {
    if (key.kind === 'new' && this.#composingNew) return
    const epoch = ++this.#epoch
    this.#referenceRecoveryShown = false
    this.#pendingMaterialRemoval = null
    this.#deps.display.reset()
    this.#composingNew = key.kind === 'new'
    this.#pendingKey = key.kind === 'pending' ? key.key : null
    this.#selectedId = key.kind === 'session' ? key.session.id : null
    switch (key.kind) {
      case 'session': {
        // A real display switch must not expose facts or editable state
        // from the prior context while this session restores.
        this.#applyDraft(null, null, null, true)
        this.#deriveActionState()
        void this.#restoreSession(epoch, key.session, 'enter')
        break
      }
      case 'pending': {
        this.#restoreWindow = true
        this.#deriveActionState()
        this.#deps.tasks.leave()
        // The temporary entry's return path: no server facts are read (no
        // identity exists); the deck rebinds to runtime-held files, or to
        // the record alone when the chain died before a reload.
        const staged = this.#deps.actions.stagedMaterials(key.key)
        const stagedIds = new Set<string>()
        for (const entry of staged) {
          stagedIds.add(entry.localId)
          this.#deps.display.registerPending(entry.localId, entry.file)
        }
        this.#restoreLocalContext(key.key, stagedIds)
        break
      }
      case 'new': {
        this.#restoreWindow = true
        this.#deriveActionState()
        this.#deps.tasks.leave()
        // Pending composing files cannot survive a restart; their bindings
        // die with them (ADR-0017), so nothing re-registers them here.
        this.#restoreLocalContext('new', new Set())
        break
      }
      case 'inactive': {
        this.#applyDraft(null, null, null, true)
        this.#deriveActionState()
        this.#deps.tasks.leave()
        break
      }
    }
    this.#changed()
  }

  /** Absorbs the former `preserveTransient` semantics: keeps the interface
   * transient state and the refresh lifecycle identity while the current
   * session's facts re-read and merge. A pending context reconciles by
   * reloading the list (a session may have appeared); its failure never
   * tears the display down. */
  reconcileCurrentContext(): void {
    if (this.#pendingKey !== null) {
      void this.#loadSessions()
      return
    }
    if (this.#selectedId === null) return
    const session = this.#sessions.find((candidate) => candidate.id === this.#selectedId)
    if (session === undefined) return
    this.#deriveActionState()
    void this.#restoreSession(++this.#epoch, session, 'reconcile')
    this.#changed()
  }

  /** Deletes a session: the list drops it, and the current context falls
   * back to the blank state when it was the one being viewed. */
  deleteSession(sessionId: string): void {
    void (async () => {
      const result = await this.#deps.actions.deleteSession(sessionId)
      if (result.outcome !== 'succeeded' || !this.#active) return
      if (this.#selectedId === sessionId) this.enterContext({ kind: 'inactive' })
      this.#setSessions(this.#sessions.filter((session) => session.id !== sessionId))
      this.#changed()
    })()
  }

  /** `selected` derives from this list, so the workspace title follows.
   * Optimistic like deleteSession: a failed PATCH surfaces on the next
   * reload instead of rolling the visible name back. */
  renameSession(sessionId: string, name: string): void {
    this.#setSessions(
      this.#sessions.map((session) => (session.id === sessionId ? { ...session, name } : session))
    )
    void this.#deps.renameSession(sessionId, name).catch(() => undefined)
    this.#changed()
  }

  /** A pending draft's session materialized: the list adopts the real
   * session; only the context still watching that pending draft follows
   * the conversion, every other display keeps its own context. */
  noteSessionMaterialized(session: CreationSessionView, pendingKey: string): void {
    this.#setSessions([session, ...this.#sessions.filter((entry) => entry.id !== session.id)])
    if (this.#pendingKey === pendingKey) this.enterContext({ kind: 'session', session })
    this.#changed()
  }

  /** The thin event route for runtime action events affecting the current
   * context; `sessions-reconcile` and `materialized` are translated by the
   * workbench hook into reload and noteSessionMaterialized calls. */
  noteRuntimeEvent(event: ContextActionEvent): void {
    const key = this.#actionKey()
    if (key === null) return
    if (event.sessionId !== '' && event.sessionId !== key) return
    this.#deriveActionState()
    this.#syncOperationNotice(key)
    this.#changed()
    if (this.#actionState.status === 'retired') {
      this.#deps.tasks.leave()
      return
    }
    if (event.type !== 'reconcile') return
    if (this.#pendingKey !== null) {
      void this.#loadSessions()
      return
    }
    const session = this.#sessions.find((candidate) => candidate.id === key)
    if (session !== undefined) void this.#restoreSession(++this.#epoch, session, 'reconcile')
  }

  reload(): void {
    void this.#loadSessions()
  }

  /** Records the loaded manifest and lets it seed an untouched context
   * exactly once; an unavailable manifest degrades nothing here. */
  noteManifest(manifest: CapabilityManifest): void {
    this.#manifest = manifest
    this.#seenManifestVersion = manifest.manifestVersion
    this.#adoptManifestDefaults()
  }

  /** Applies a creator edit and persists it under the composing surface's
   * draft key (`pending:<uuid>`, else `new`, else the session; ADR-0017). */
  editDraft(value: ComposerDraft): void {
    this.#draft = value
    const key = this.#draftKey()
    if (key !== null) this.#writeThrough(key, value)
    this.#changed()
  }

  /** The submit path's synchronous ownership claim: the record lands under
   * the pending key and the composing key dies before any await. */
  claimPendingDraft(key: string, frozen: ComposerDraft): void {
    this.#composingNew = false
    this.#pendingKey = key
    this.#writeThrough(key, frozen)
    if (this.#storage !== undefined) removeLocalDraft(this.#storage, this.#deps.userId, 'new')
    this.#deriveActionState()
    this.#changed()
  }

  /** The manifest version a persisted record or submission carries: what
   * the composer last saw, else the restored record's own, else the
   * contract floor. */
  manifestVersionForIntent(): number {
    return this.#seenManifestVersion ?? this.#recordManifestVersion ?? 1
  }

  /** A language change re-mirrors the localized prompt expansion into the
   * stored record even though the identity-bearing document is unchanged. */
  setMentionLabels(labels: PromptMentionKindLabels): void {
    if (labels === this.#mentionLabels) return
    this.#mentionLabels = labels
    const key = this.#draftKey()
    if (key !== null) this.#writeThrough(key, this.#draft)
  }

  /** Clears the current context's action failure: the acknowledged state
   * re-derives submitError to null. */
  acknowledgeActionFailure(): void {
    const key = this.#actionKey()
    if (key !== null) this.#deps.actions.acknowledgeFailure(key)
    this.#deriveActionState()
    this.#changed()
  }

  noteMaterialUploadFailed(failed: boolean): void {
    this.#materialUploadFailed = failed
    this.#changed()
  }

  noteMaterialDropRejection(rejection: WorkbenchContextSnapshot['materialDropRejection']): void {
    this.#materialDropRejection = rejection
    this.#changed()
  }

  notePendingMaterialRemoval(removal: WorkbenchContextSnapshot['pendingMaterialRemoval']): void {
    this.#pendingMaterialRemoval = removal
    this.#changed()
  }

  dismissReferenceRecovery(): void {
    this.#referenceRecoveryShown = false
    this.#changed()
  }

  async #loadSessions(): Promise<void> {
    const epoch = this.#epoch
    const result = await this.#deps.listSessions().catch(() => null)
    if (!this.#active || epoch !== this.#epoch) return
    if (result !== null && result.outcome === 'succeeded') {
      this.#status = 'ready'
      this.#setSessions(result.value.sessions)
    } else {
      this.#status = 'error'
    }
    this.#changed()
  }

  async #restoreSession(
    epoch: number,
    session: CreationSessionView,
    mode: 'enter' | 'reconcile'
  ): Promise<void> {
    this.#restoreWindow = true
    if (mode === 'enter') this.#deps.tasks.enter(session.id)
    else this.#deps.tasks.requestReconcile()
    const [detail, materialPage] = await Promise.all([
      this.#deps.getSessionDetail(session.id).catch(() => null),
      this.#deps.listMaterials(session.id).catch(() => null)
    ])
    if (!this.#isCurrent(epoch, session.id)) {
      // A stale read retires itself only: the window belongs to whatever
      // ritual currently owns the epoch, and closing it here would let a
      // manifest landing now seed the optimistic empty of a restore still
      // in flight.
      return
    }
    this.#restoreWindow = false
    if (
      detail === null ||
      detail.outcome !== 'succeeded' ||
      materialPage === null ||
      materialPage.outcome !== 'succeeded'
    ) {
      if (mode === 'enter') {
        // Entering failed: surface the outage and tear the half-initialized
        // context down to the blank state. A background reconcile is
        // best-effort: its outage must not erase the current editable
        // Draft or replace still-useful Go facts.
        this.#status = 'error'
        this.#selectedId = null
        this.#deriveActionState()
        this.#deps.tasks.leave()
        this.#changed()
      }
      return
    }
    const staged = this.#deps.actions.stagedMaterials(session.id)
    const stagedIds = new Set(staged.map((entry) => entry.localId))
    for (const materialId of this.#deps.display.pendingFiles().keys()) {
      if (stagedIds.has(materialId)) continue
      // The draft binding remaps onto the resolved identity in this same
      // restore; every other orphan pending still just drops.
      const resolvedId = this.#deps.actions.resolvedMaterialId(session.id, materialId)
      if (resolvedId !== null) this.#deps.display.transferPending(materialId, resolvedId)
      else this.#deps.display.dropPending(materialId)
    }
    const stagedViews = staged
      .filter(
        (entry) => !materialPage.value.materials.some((material) => material.id === entry.localId)
      )
      .map((entry) => this.#deps.display.registerPending(entry.localId, entry.file))
    const visibleMaterials = [...materialPage.value.materials, ...stagedViews]
    this.#deps.display.replaceMaterials(visibleMaterials)
    // The editable draft is device-local state: restore this device's copy
    // and prune reference bindings whose materials no longer exist in the
    // session (deleted from another surface — nothing rewrote them here).
    const stored = this.#readDraft(session.id)
    if (stored === null) {
      this.#applyDraft(
        this.#manifest === null ? null : manifestDefaultDraft(this.#manifest),
        null,
        null,
        mode === 'enter'
      )
    } else {
      const known = new Set(visibleMaterials.map((material) => material.id))
      const value = this.#restoreStoredDraft(stored, known)
      this.#applyDraft(
        value,
        stored.manifestVersion,
        stored.operationNotice ?? null,
        mode === 'enter'
      )
      this.#writeThrough(session.id, value)
      if (this.#seenManifestVersion === null) {
        this.#seenManifestVersion = stored.manifestVersion
      }
    }
    this.#changed()
  }

  /** Synchronous local restore for the `pending` and `new` rows: the
   * device-local record or, when absent, the manifest-seeded defaults. */
  #restoreLocalContext(key: string, stagedIds: ReadonlySet<string>): void {
    const stored = this.#readDraft(key)
    if (stored === null) {
      this.#applyDraft(
        this.#manifest === null ? null : manifestDefaultDraft(this.#manifest),
        null,
        null,
        true
      )
    } else {
      const value = this.#restoreStoredDraft(stored, stagedIds)
      this.#applyDraft(value, stored.manifestVersion, stored.operationNotice ?? null, true)
      this.#writeThrough(key, value)
      if (this.#seenManifestVersion === null) {
        this.#seenManifestVersion = stored.manifestVersion
      }
    }
    this.#restoreWindow = false
  }

  /** Unknown-material bindings drop out; their last expanded prompt
   * survives as plain text — identity cannot be reconstructed after a
   * material disappears, so nothing is guessed at. */
  #restoreStoredDraft(
    stored: LocalDraftRecord,
    knownMaterialIds: ReadonlySet<string>
  ): ComposerDraft {
    const references = stored.references.filter((reference) =>
      knownMaterialIds.has(reference.materialId)
    )
    const prunedPromptDocument = prunePromptMentions(stored.promptDocument, references)
    const recovered =
      references.length !== stored.references.length ||
      JSON.stringify(prunedPromptDocument) !== JSON.stringify(stored.promptDocument)
    const promptDocument = recovered ? textPromptDocument(stored.prompt) : prunedPromptDocument
    if (recovered) this.#referenceRecoveryShown = true
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
  }

  /** Manifest adoption invariant: the manifest seeds defaults only into an
   * entered context's untouched empty draft — never into an unentered
   * workbench, and never into the optimistic empty a context switch shows
   * while its record restores. */
  #adoptManifestDefaults(): void {
    if (!this.#contextEntered() || this.#restoreWindow) return
    if (JSON.stringify(this.#draft) !== JSON.stringify(emptyComposerDraft())) return
    const seeded = this.#manifest === null ? null : manifestDefaultDraft(this.#manifest)
    if (seeded !== null) this.editDraft(seeded)
  }

  #contextEntered(): boolean {
    return this.#selectedId !== null || this.#composingNew || this.#pendingKey !== null
  }

  #applyDraft(
    stored: ComposerDraft | null,
    manifestVersion: number | null,
    nextOperationNotice: LocalDraftOperationNotice | null,
    resetTransient: boolean
  ): void {
    this.#recordManifestVersion = manifestVersion
    this.#operationNotice = nextOperationNotice
    this.#draft = stored ?? emptyComposerDraft()
    if (resetTransient) {
      this.#materialUploadFailed = false
      // A surface switch must not carry the previous surface's drop summary.
      this.#materialDropRejection = null
    }
  }

  #writeThrough(key: string, value: ComposerDraft): void {
    if (this.#storage === undefined) return
    const candidates = promptMentionCandidates(
      value.references,
      this.#deps.display.getSnapshot().materials,
      this.#mentionLabels
    )
    const record: LocalDraftRecord = {
      ...value,
      prompt: expandPromptDocument(value.promptDocument, candidates),
      manifestVersion: this.manifestVersionForIntent(),
      ...(this.#operationNotice === null ? {} : { operationNotice: this.#operationNotice })
    }
    writeLocalDraft(this.#storage, this.#deps.userId, key, record)
  }

  #readDraft(key: string): LocalDraftRecord | null {
    return this.#storage === undefined
      ? null
      : readLocalDraft(this.#storage, this.#deps.userId, key)
  }

  #deriveActionState(): void {
    const key = this.#actionKey()
    this.#actionState = key === null ? { status: 'idle' } : this.#deps.actions.snapshot(key)
    this.#submitError = this.#actionState.status === 'failed' ? this.#actionState.code : null
  }

  #syncOperationNotice(key: string): void {
    const stored = this.#readDraft(key)
    this.#operationNotice = stored?.operationNotice ?? null
  }

  #setSessions(sessions: readonly CreationSessionView[]): void {
    this.#sessions = sessions
    // Disappearance detection: every list replacement diffs the current
    // context, so a server-side deletion tears the workbench down to the
    // blank state instead of pointing at a session that no longer exists.
    if (
      this.#status === 'ready' &&
      this.#selectedId !== null &&
      !sessions.some((session) => session.id === this.#selectedId)
    ) {
      this.enterContext({ kind: 'inactive' })
    }
  }

  /** A restore continues only when its epoch is still current, the
   * controller is live, and the session it read for is still the one being
   * presented. */
  #isCurrent(epoch: number, sessionId: string): boolean {
    return this.#active && epoch === this.#epoch && this.#selectedId === sessionId
  }

  /** The action-state key: the pending ownership, else the session; a
   * fresh composition has no runtime action of its own. */
  #actionKey(): string | null {
    return this.#pendingKey ?? this.#selectedId
  }

  /** The draft-store key; the blank state persists nothing (ADR-0017). */
  #draftKey(): string | null {
    const key = this.#contextKeyValue()
    return key === 'inactive' ? null : key
  }

  /** The one spelling of the presented context: the pending ownership, else
   * `new` while composing, else the session id, else `inactive`. */
  #contextKeyValue(): string {
    if (this.#pendingKey !== null) return this.#pendingKey
    if (this.#composingNew) return 'new'
    return this.#selectedId ?? 'inactive'
  }

  #changed(): void {
    this.#snapshot = {
      status: this.#status,
      sessions: this.#sessions,
      selected:
        this.#selectedId === null
          ? null
          : (this.#sessions.find((session) => session.id === this.#selectedId) ?? null),
      selectedId: this.#selectedId,
      composingNew: this.#composingNew,
      pendingKey: this.#pendingKey,
      contextKey: this.#contextKeyValue(),
      actionKey: this.#actionKey(),
      draft: this.#draft,
      actionState: this.#actionState,
      submitError: this.#submitError,
      operationNotice: this.#operationNotice,
      referenceRecoveryShown: this.#referenceRecoveryShown,
      pendingMaterialRemoval: this.#pendingMaterialRemoval,
      materialUploadFailed: this.#materialUploadFailed,
      materialDropRejection: this.#materialDropRejection
    }
    for (const notify of [...this.#listeners]) notify()
  }
}
