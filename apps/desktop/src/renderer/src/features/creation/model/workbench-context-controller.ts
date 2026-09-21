/**
 * The Workbench Context controller (issue #206): owner of the context the Creation Workbench
 * presents and of the single switching ritual every navigation target goes through (display reset,
 * task-refresh leave/enter, draft restore, staged file re-registration). Variants derive from the
 * target kind, never from caller-passed mode flags. Framework-free, so its concurrency invariants
 * (the generation token that invalidates in-flight reads, the manifest adoption invariant) stay
 * testable against scripted deps.
 */
import type { CapabilityManifest } from '../api/capability-manifest-http'
import {
  emptyGenerationParameters,
  manifestDefaultParameters,
  type GenerationParameterValues
} from '../api/generation-parameter'
import type {
  CreationApiResult,
  CreationSessionView,
  DraftReferenceView,
  MaterialPage,
  ReferenceMaterialView,
  SessionDetailView
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
import type { CreationSessionNavigationTarget } from './creation-session-navigation-controller'

/**
 * The composer's editable mirror of the session draft: field values are exactly
 * what the creator sees, and the manifest only adds candidate menus and stale
 * verdicts, never rewriting them.
 */
export interface ComposerDraft extends GenerationParameterValues {
  promptDocument: PromptDocument
  references: DraftReferenceView[]
}

export const emptyComposerDraft = (): ComposerDraft => ({
  promptDocument: textPromptDocument(''),
  ...emptyGenerationParameters(),
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
  recoveryMaterials?(key: string): readonly ReferenceMaterialView[]
  beginMaterialsObservation?(key: string): number
  observeMaterials?(key: string, materialIds: readonly string[], observation: number): void
  resolvedMaterialId(sessionId: string, localId: string): string | null
  acknowledgeFailure(key: string): void
}

/** The read and orchestration seams this module consumes; no submit,
 * cancel, or retry crosses them. */
export interface WorkbenchContextDeps {
  readonly userId: string
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
  readonly selected: CreationSessionView | null
  readonly selectedId: string | null
  readonly composingNew: boolean
  readonly pendingKey: string | null
  /** True while the entered session's restore is in flight. */
  readonly restoring: boolean
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
  selected: null,
  selectedId: null,
  composingNew: false,
  pendingKey: null,
  restoring: false,
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
    resolution: model?.defaultResolution ?? null,
    ...manifestDefaultParameters(capability),
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
  // Every context transition and lifecycle suspend bumps it; reads carry the
  // epoch they started under and are discarded when it no longer matches.
  #epoch = 0
  // Open from a context switch's optimistic reset until its record (or the
  // fallback) lands; #adoptManifestDefaults owns why adoption must wait.
  #restoreWindow = false
  // Narrower than #restoreWindow: a reconcile opens that one alone.
  #restoring = false
  #selected: CreationSessionView | null = null
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

  /** Re-asserts liveness; StrictMode's effect replay re-runs this on the
   * same instance after suspend retired the first lifecycle's reads. */
  activate(): void {
    this.#active = true
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

  /** The one switching ritual, its transition derived from the target kind:
   * `session` restores asynchronously, merges server facts, and reconciles
   * staged files; `pending`/`new` restore from the local record or seed
   * defaults; `inactive` keeps nothing. */
  enterContext(key: CreationSessionNavigationTarget): void {
    if (key.kind === 'new' && this.#composingNew) return
    // Re-entering only refreshes the object, unless the restore never landed —
    // a replayed (StrictMode) entry leaves nothing for a refresh to present.
    if (key.kind === 'session' && this.#selected?.id === key.session.id && !this.#restoreWindow) {
      this.#selected = key.session
      this.#changed()
      return
    }
    const epoch = ++this.#epoch
    this.#referenceRecoveryShown = false
    this.#pendingMaterialRemoval = null
    this.#deps.display.reset()
    this.#composingNew = key.kind === 'new'
    this.#pendingKey = key.kind === 'pending' ? key.key : null
    this.#selected = key.kind === 'session' ? key.session : null
    switch (key.kind) {
      case 'session': {
        // A real display switch must not expose facts or editable state
        // from the prior context while this session restores.
        this.#applyDraft(null, null, null, true)
        this.#deriveActionState()
        this.#restoring = true
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

  /** Keeps the interface transient state and refresh identity while the
   * current session's facts re-read and merge. */
  reconcileCurrentContext(): void {
    const session = this.#selected
    if (session === null) return
    this.#deriveActionState()
    void this.#restoreSession(++this.#epoch, session, 'reconcile')
    this.#changed()
  }

  /** The thin event route for runtime action events affecting the current context. */
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
    if (this.#selected !== null) {
      void this.#restoreSession(++this.#epoch, this.#selected, 'reconcile')
    }
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
    if (this.#restoreWindow) return
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

  async #restoreSession(
    epoch: number,
    session: CreationSessionView,
    mode: 'enter' | 'reconcile'
  ): Promise<void> {
    this.#restoreWindow = true
    if (mode === 'enter') this.#deps.tasks.enter(session.id)
    else this.#deps.tasks.requestReconcile()
    const materialObservation = this.#deps.actions.beginMaterialsObservation?.(session.id) ?? 0
    const [detail, materialPage] = await Promise.all([
      this.#deps.getSessionDetail(session.id).catch(() => null),
      this.#deps.listMaterials(session.id).catch(() => null)
    ])
    if (!this.#isCurrent(epoch, session.id)) {
      // A stale read retires itself only: the window belongs to whatever ritual
      // owns the epoch, and closing it here would let a manifest landing now
      // seed the optimistic empty of a restore still in flight.
      return
    }
    this.#restoreWindow = false
    this.#restoring = false
    if (
      detail === null ||
      detail.outcome !== 'succeeded' ||
      materialPage === null ||
      materialPage.outcome !== 'succeeded'
    ) {
      if (mode === 'enter') {
        // Entering failed: surface the outage and tear the half-initialized
        // context down to the blank state. A background reconcile is
        // best-effort: its outage must not erase the editable Draft or Go facts.
        this.#selected = null
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
    this.#deps.actions.observeMaterials?.(
      session.id,
      materialPage.value.materials.map((material) => material.id),
      materialObservation
    )
    const recoveryViews = (this.#deps.actions.recoveryMaterials?.(session.id) ?? []).filter(
      (recovery) =>
        !materialPage.value.materials.some((material) => material.id === recovery.id) &&
        !stagedViews.some((material) => material.id === recovery.id)
    )
    const visibleMaterials = [...materialPage.value.materials, ...stagedViews, ...recoveryViews]
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
    this.#restoring = false
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
   * entered context's untouched empty draft — never an unentered workbench, nor
   * the optimistic empty a context switch shows while its record restores. */
  #adoptManifestDefaults(): void {
    if (!this.#contextEntered() || this.#restoreWindow) return
    if (JSON.stringify(this.#draft) !== JSON.stringify(emptyComposerDraft())) return
    const seeded = this.#manifest === null ? null : manifestDefaultDraft(this.#manifest)
    if (seeded !== null) this.editDraft(seeded)
  }

  #contextEntered(): boolean {
    return this.#selected !== null || this.#composingNew || this.#pendingKey !== null
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

  /** A restore continues only when its epoch is still current, the
   * controller is live, and the session it read for is still the one being
   * presented. */
  #isCurrent(epoch: number, sessionId: string): boolean {
    return this.#active && epoch === this.#epoch && this.#selected?.id === sessionId
  }

  /** The action-state key: the pending ownership, else the session; a
   * fresh composition has no runtime action of its own. */
  #actionKey(): string | null {
    return this.#pendingKey ?? this.#selected?.id ?? null
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
    return this.#selected?.id ?? 'inactive'
  }

  #changed(): void {
    this.#snapshot = {
      selected: this.#selected,
      selectedId: this.#selected?.id ?? null,
      composingNew: this.#composingNew,
      pendingKey: this.#pendingKey,
      restoring: this.#restoring,
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
