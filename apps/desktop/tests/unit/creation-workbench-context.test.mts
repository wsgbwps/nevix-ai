import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isDesktopSource = context.parentURL?.includes('/apps/desktop/src/') === true
    const resolvedSpecifier =
      isDesktopSource && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)
        ? `${specifier}.ts`
        : specifier
    return nextResolve(resolvedSpecifier, context)
  }
})

const { WorkbenchContextController } =
  await import('../../src/renderer/src/features/creation/model/workbench-context-controller.ts')
const { readLocalDraft, writeLocalDraft, remapLocalDraftMaterial } =
  await import('../../src/renderer/src/features/creation/model/draft-store.ts')
const { textPromptDocument } =
  await import('../../src/renderer/src/features/creation/model/prompt-document.ts')
import type { WorkbenchContextDeps } from '../../src/renderer/src/features/creation/model/workbench-context-controller.ts'
import type { LocalDraftRecord } from '../../src/renderer/src/features/creation/model/draft-store.ts'
import type { CapabilityManifest } from '../../src/renderer/src/features/creation/api/capability-manifest-http.ts'
import type {
  CreationApiResult,
  CreationSessionView,
  MaterialPage,
  ReferenceMaterialView
} from '../../src/renderer/src/features/creation/api/go-creation-http.ts'
import type {
  StagedMaterialFile,
  WorkbenchActionState
} from '../../src/renderer/src/features/creation/model/workbench-runtime.ts'
import type { PendingMaterialFile } from '../../src/renderer/src/features/creation/model/workbench-display-controller.ts'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const ok = <T,>(value: T): CreationApiResult<T> => ({ outcome: 'succeeded', value })

function sessionView(id: string, name = id): CreationSessionView {
  return { id, name, createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z' }
}

function materialView(id: string): ReferenceMaterialView {
  return {
    id,
    kind: 'image',
    fileName: `${id}.png`,
    mimeType: 'image/png',
    byteSize: 1,
    widthPx: null,
    heightPx: null,
    pixelCount: null,
    durationMs: null,
    checksumSha256: '',
    claimsVersion: 0,
    createdAt: '1970-01-01T00:00:00.000Z'
  }
}

function imageFile(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
}

/** A minimal published manifest: image only, one model, one mode. */
const seedManifest: CapabilityManifest = {
  schemaVersion: 2,
  manifestVersion: 5,
  image: {
    available: true,
    reason: null,
    action: null,
    models: [{ model: 'm-1', resolutions: ['1K'], defaultResolution: '1K' }],
    modes: [{ id: 'text-to-image', referenceMaterial: { total: { min: 0, max: 0 } } }],
    defaults: { ratio: '1:1', quantity: 1 }
  },
  video: { available: false, reason: null, action: null }
}

function draftRecord(overrides: Partial<LocalDraftRecord> = {}): LocalDraftRecord {
  return {
    prompt: 'hello',
    promptDocument: textPromptDocument('hello'),
    mediaType: 'image',
    manifestVersion: 4,
    model: 'stored-model',
    mode: 'text-to-image',
    ratio: '1:1',
    resolution: '1K',
    quantity: 1,
    durationSeconds: null,
    references: [],
    ...overrides
  }
}

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, String(value))
    },
    removeItem: (key) => {
      items.delete(key)
    },
    clear: () => items.clear()
  }
}

class FakeDisplay {
  resetCount = 0
  readonly replaced: ReferenceMaterialView[][] = []
  readonly registered: string[] = []
  readonly dropped: string[] = []
  readonly transferred: [localId: string, resolvedId: string][] = []
  readonly #pending = new Map<string, PendingMaterialFile>()
  #materials: readonly ReferenceMaterialView[] = []

  reset(): void {
    this.#pending.clear()
    this.#materials = []
    this.resetCount += 1
  }

  replaceMaterials(views: readonly ReferenceMaterialView[]): void {
    this.#materials = views
    this.replaced.push([...views])
  }

  registerPending(id: string, file: File): ReferenceMaterialView {
    this.#pending.set(id, { file })
    this.#materials = [...this.#materials, materialView(id)]
    this.registered.push(id)
    return materialView(id)
  }

  dropPending(materialId: string): void {
    this.#pending.delete(materialId)
    this.dropped.push(materialId)
  }

  transferPending(localId: string, resolvedId: string): void {
    this.#pending.delete(localId)
    this.transferred.push([localId, resolvedId])
  }

  pendingFiles(): ReadonlyMap<string, PendingMaterialFile> {
    return this.#pending
  }

  getSnapshot(): { materials: readonly ReferenceMaterialView[] } {
    return { materials: this.#materials }
  }
}

class FakeTasks {
  readonly entered: string[] = []
  leaveCount = 0
  reconcileCount = 0

  enter(sessionId: string): void {
    this.entered.push(sessionId)
  }

  leave(): void {
    this.leaveCount += 1
  }

  requestReconcile(): void {
    this.reconcileCount += 1
  }
}

type ReadEntry<T> = T | { promise: Promise<T>; resolve: (value: T) => void }

function readEntry<T>(entry: ReadEntry<T> | undefined, fallback: () => T): Promise<T> {
  if (entry === undefined) return Promise.resolve(fallback())
  if (typeof (entry as { resolve?: unknown }).resolve === 'function') {
    return (entry as { promise: Promise<T> }).promise
  }
  return Promise.resolve(entry as T)
}

class Harness {
  readonly storage = memoryStorage()
  readonly display = new FakeDisplay()
  readonly tasks = new FakeTasks()
  readonly script = {
    detail: new Map<string, ReadEntry<CreationApiResult<CreationSessionView>>>(),
    materials: new Map<string, ReadEntry<CreationApiResult<MaterialPage>>>()
  }
  readonly actions = {
    states: new Map<string, WorkbenchActionState>(),
    staged: new Map<string, readonly StagedMaterialFile[]>(),
    recovering: new Map<string, readonly ReferenceMaterialView[]>(),
    resolved: new Map<string, string>(),
    acknowledged: [] as string[],
    snapshot: (key: string): WorkbenchActionState =>
      this.actions.states.get(key) ?? { status: 'idle' },
    stagedMaterials: (key: string): readonly StagedMaterialFile[] =>
      this.actions.staged.get(key) ?? [],
    recoveryMaterials: (key: string): readonly ReferenceMaterialView[] =>
      this.actions.recovering.get(key) ?? [],
    observeMaterials: (key: string, materialIds: readonly string[]): void => {
      const observed = new Set(materialIds)
      this.actions.recovering.set(
        key,
        (this.actions.recovering.get(key) ?? []).filter((material) => !observed.has(material.id))
      )
    },
    resolvedMaterialId: (sessionId: string, localId: string): string | null =>
      this.actions.resolved.get(`${sessionId}:${localId}`) ?? null,
    acknowledgeFailure: (key: string): void => {
      this.actions.acknowledged.push(key)
      this.actions.states.delete(key)
    }
  }
  readonly controller: WorkbenchContextController

  constructor() {
    const deps: WorkbenchContextDeps = {
      userId: 'user-1',
      getSessionDetail: (sessionId) =>
        readEntry(this.script.detail.get(sessionId), () => ok(sessionView(sessionId))),
      listMaterials: (sessionId) =>
        readEntry(this.script.materials.get(sessionId), () =>
          ok({ materials: [], nextCursor: null })
        ),
      actions: this.actions,
      display: this.display,
      tasks: this.tasks
    }
    this.controller = new WorkbenchContextController(deps, { storage: this.storage })
    this.controller.activate()
  }
}

const harness = (): Harness => new Harness()

test('the session row: optimistic reset, async merge, staged reconcile, record restore', async () => {
  const { controller, storage, display, tasks, script, actions } = harness()
  writeLocalDraft(
    storage,
    'user-1',
    's1',
    draftRecord({ references: [{ materialId: 'm1', role: 'reference' }] })
  )
  const slowDetail = deferred<CreationApiResult<CreationSessionView>>()
  script.detail.set('s1', slowDetail)
  script.materials.set('s1', ok({ materials: [materialView('m1')], nextCursor: null }))
  actions.staged.set('s1', [
    { localId: 'p2', file: imageFile('b.png') },
    { localId: 'p3', file: imageFile('c.png') }
  ])
  let notifications = 0
  controller.subscribe(() => {
    notifications += 1
  })
  await flush()

  controller.enterContext({ kind: 'session', session: sessionView('s1') })

  // Optimistic phase: the switch never exposes prior-context facts.
  assert.ok(notifications > 0)
  assert.equal(display.resetCount, 1)
  assert.deepEqual(tasks.entered, ['s1'])
  assert.equal(controller.getSnapshot().selectedId, 's1')
  assert.deepEqual(controller.getSnapshot().draft.references, [])

  // A file added while the restore is still in flight is not staged; the
  // reconciling landing must drop it again.
  display.registerPending('p-mid', imageFile('mid.png'))
  slowDetail.resolve(ok(sessionView('s1')))
  await flush()

  // Ghost-card regression: staged files survive the reconciling transition,
  // in runtime order, appended after the server page.
  assert.deepEqual(display.dropped, ['p-mid'])
  assert.deepEqual(display.registered, ['p-mid', 'p2', 'p3'])
  assert.deepEqual(
    display.replaced.at(-1)?.map((material) => material.id),
    ['m1', 'p2', 'p3']
  )
  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.draft.model, 'stored-model')
  assert.deepEqual(snapshot.draft.references, [{ materialId: 'm1', role: 'reference' }])
  assert.equal(controller.manifestVersionForIntent(), 4)
})

test('the session row: a reconciling restore transfers a resolved staged upload, not drops it', async () => {
  const { controller, storage, display, script, actions } = harness()
  writeLocalDraft(
    storage,
    'user-1',
    's1',
    draftRecord({ references: [{ materialId: 'p1', role: 'reference' }] })
  )
  script.materials.set('s1', ok({ materials: [], nextCursor: null }))
  actions.staged.set('s1', [{ localId: 'p1', file: imageFile('a.png') }])
  await flush()

  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  await flush()
  assert.ok(!display.dropped.includes('p1'))

  // Resolved: out of staging, identity answerable, draft remapped.
  actions.staged.set('s1', [])
  actions.resolved.set('s1:p1', 'm1')
  script.materials.set('s1', ok({ materials: [materialView('m1')], nextCursor: null }))
  remapLocalDraftMaterial(storage, 'user-1', 's1', 'p1', 'm1')

  controller.noteRuntimeEvent({ type: 'reconcile', sessionId: 's1' })
  await flush()

  assert.deepEqual(display.transferred, [['p1', 'm1']])
  assert.ok(!display.dropped.includes('p1'))
  assert.deepEqual(controller.getSnapshot().draft.references, [
    { materialId: 'm1', role: 'reference' }
  ])
  assert.deepEqual(
    display.replaced.at(-1)?.map((material) => material.id),
    ['m1']
  )
})

test('the session row preserves a restart-recovery binding before the server material appears', async () => {
  const { controller, storage, script, actions, display } = harness()
  writeLocalDraft(
    storage,
    'user-1',
    's1',
    draftRecord({ references: [{ materialId: 'recovering-1', role: 'reference' }] })
  )
  script.materials.set('s1', ok({ materials: [], nextCursor: null }))
  actions.recovering.set('s1', [materialView('recovering-1')])
  await flush()

  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  await flush()

  assert.deepEqual(controller.getSnapshot().draft.references, [
    { materialId: 'recovering-1', role: 'reference' }
  ])
  assert.deepEqual(readLocalDraft(storage, 'user-1', 's1')?.references, [
    { materialId: 'recovering-1', role: 'reference' }
  ])
  assert.deepEqual(
    display.replaced.at(-1)?.map((material) => material.id),
    ['recovering-1']
  )
})

test('the session row: an enter failure surfaces the outage and tears down', async () => {
  const { controller, script, tasks } = harness()
  script.detail.set('s1', { outcome: 'network-failure' })
  await flush()

  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  await flush()

  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.selectedId, null)
  assert.deepEqual(tasks.entered, ['s1'])
  assert.equal(tasks.leaveCount, 1)
  assert.deepEqual(snapshot.draft.references, [])
})

test('the pending row: full staged re-registration and record restore, no server reads', () => {
  const { controller, storage, display, tasks, script, actions } = harness()
  writeLocalDraft(
    storage,
    'user-1',
    'pending:k',
    draftRecord({
      references: [
        { materialId: 'p1', role: 'reference' },
        { materialId: 'ghost', role: 'reference' },
        { materialId: 'p2', role: 'reference' }
      ]
    })
  )
  actions.staged.set('pending:k', [
    { localId: 'p2', file: imageFile('b.png') },
    { localId: 'p1', file: imageFile('a.png') }
  ])

  controller.enterContext({ kind: 'pending', key: 'pending:k' })

  assert.deepEqual(display.registered, ['p2', 'p1'])
  assert.equal(display.resetCount, 1)
  assert.equal(tasks.leaveCount, 1)
  assert.equal(controller.getSnapshot().pendingKey, 'pending:k')
  // Bindings whose files the runtime no longer holds drop out; the
  // surviving order follows the record, not the registration order.
  assert.deepEqual(controller.getSnapshot().draft.references, [
    { materialId: 'p1', role: 'reference' },
    { materialId: 'p2', role: 'reference' }
  ])
  assert.equal(script.detail.size, 0)
})

test('the new row: seeds defaults once, and composing files never re-register', () => {
  const { controller, display } = harness()
  controller.noteManifest(seedManifest)

  controller.enterContext({ kind: 'new' })

  assert.deepEqual(display.registered, [])
  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.composingNew, true)
  assert.equal(snapshot.draft.mediaType, 'image')
  assert.equal(snapshot.draft.model, 'm-1')
  assert.equal(controller.manifestVersionForIntent(), 5)
})

test('the new row: a surviving local composing record restores instead', () => {
  const { controller, storage } = harness()
  writeLocalDraft(storage, 'user-1', 'new', draftRecord())
  controller.noteManifest(seedManifest)

  controller.enterContext({ kind: 'new' })

  assert.equal(controller.getSnapshot().draft.model, 'stored-model')
})

test('the inactive row drops every context and file', async () => {
  const { controller, storage, display, tasks, script } = harness()
  writeLocalDraft(storage, 'user-1', 's1', draftRecord())
  script.materials.set('s1', ok({ materials: [materialView('m1')], nextCursor: null }))
  await flush()
  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  await flush()
  assert.equal(controller.getSnapshot().selectedId, 's1')

  controller.enterContext({ kind: 'inactive' })

  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.selectedId, null)
  assert.equal(snapshot.composingNew, false)
  assert.equal(snapshot.pendingKey, null)
  assert.deepEqual(snapshot.draft.references, [])
  assert.equal(display.resetCount, 2)
  assert.equal(tasks.leaveCount, 1)
})

test('the context key is the one spelling every transition updates', async () => {
  const { controller } = harness()
  await flush()
  assert.equal(controller.getSnapshot().contextKey, 'inactive')
  assert.equal(controller.getSnapshot().actionKey, null)

  controller.enterContext({ kind: 'new' })
  assert.equal(controller.getSnapshot().contextKey, 'new')
  assert.equal(controller.getSnapshot().actionKey, null)

  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  await flush()
  assert.equal(controller.getSnapshot().contextKey, 's1')
  assert.equal(controller.getSnapshot().actionKey, 's1')

  controller.enterContext({ kind: 'pending', key: 'pending:p1' })
  assert.equal(controller.getSnapshot().contextKey, 'pending:p1')
  assert.equal(controller.getSnapshot().actionKey, 'pending:p1')

  controller.enterContext({ kind: 'inactive' })
  assert.equal(controller.getSnapshot().contextKey, 'inactive')
  assert.equal(controller.getSnapshot().actionKey, null)
})

test('a stale read never closes a newer restore still in flight', async () => {
  const { controller, storage, script } = harness()
  const slowA = deferred<CreationApiResult<CreationSessionView>>()
  const slowB = deferred<CreationApiResult<CreationSessionView>>()
  script.detail.set('s1', slowA)
  script.detail.set('s2', slowB)
  writeLocalDraft(storage, 'user-1', 's2', draftRecord())
  await flush()

  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  controller.enterContext({ kind: 'session', session: sessionView('s2') })
  // The older context's read settles first and must be discarded without
  // ending the newer restore's adoption window.
  slowA.resolve(ok(sessionView('s1')))
  await flush()
  assert.equal(controller.getSnapshot().selectedId, 's2')

  controller.noteManifest(seedManifest)
  assert.equal(controller.getSnapshot().draft.model, null)

  slowB.resolve(ok(sessionView('s2')))
  await flush()
  assert.equal(controller.getSnapshot().draft.model, 'stored-model')
  assert.equal(readLocalDraft(storage, 'user-1', 's2')?.model, 'stored-model')
})

test('an enter-failure teardown leaves no live action state behind', async () => {
  const { controller, script, actions } = harness()
  actions.states.set('s1', { status: 'submitting' })
  script.detail.set('s1', { outcome: 'network-failure' })
  await flush()

  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  await flush()

  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.selectedId, null)
  assert.deepEqual(snapshot.actionState, { status: 'idle' })
  assert.equal(snapshot.submitError, null)
})

test('a stale first read cannot overwrite a later selection', async () => {
  const { controller, storage, script } = harness()
  const slowA = deferred<CreationApiResult<CreationSessionView>>()
  writeLocalDraft(storage, 'user-1', 's2', draftRecord({ model: 'b-model' }))
  script.detail.set('s1', slowA)
  await flush()

  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  controller.enterContext({ kind: 'session', session: sessionView('s2') })
  await flush()
  assert.equal(controller.getSnapshot().selectedId, 's2')

  slowA.resolve(ok(sessionView('s1')))
  await flush()

  assert.equal(controller.getSnapshot().selectedId, 's2')
  assert.equal(controller.getSnapshot().draft.model, 'b-model')
})

test('a replayed entry re-runs the session ritual instead of short-circuiting', async () => {
  const { controller, storage, display, tasks, script } = harness()
  writeLocalDraft(storage, 'user-1', 's1', draftRecord({ model: 'stored-model' }))
  script.materials.set('s1', ok({ materials: [materialView('m1')], nextCursor: null }))
  await flush()

  // React StrictMode replays a just-mounted effect — setup, cleanup, setup — and
  // the suspend retires the first entry's restore. The presented context keeps
  // its session, so a short-circuit here would leave it with no draft, no
  // materials and no task display: only the ritual can re-establish it.
  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  controller.suspend()
  controller.activate()
  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  await flush()

  assert.deepEqual(tasks.entered, ['s1', 's1'])
  assert.deepEqual(
    display.replaced.at(-1)?.map((material) => material.id),
    ['m1']
  )
  assert.equal(controller.getSnapshot().draft.model, 'stored-model')
})

test('re-entering the presented session after its restore stays a no-op', async () => {
  const { controller, display, script } = harness()
  script.materials.set('s1', ok({ materials: [materialView('m1')], nextCursor: null }))
  await flush()

  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  await flush()
  const resetsAfterEntry = display.resetCount

  controller.enterContext({ kind: 'session', session: sessionView('s1') })

  assert.equal(display.resetCount, resetsAfterEntry)
})

test('manifest adoption invariant: an unentered workbench never adopts defaults', async () => {
  const { controller } = harness()
  await flush()

  controller.noteManifest(seedManifest)
  assert.deepEqual(controller.getSnapshot().draft.references, [])
  assert.equal(controller.getSnapshot().draft.model, null)
  // Entering the composing start afterwards seeds from the known manifest.
  controller.enterContext({ kind: 'new' })
  assert.equal(controller.getSnapshot().draft.model, 'm-1')
})

test('a manifest landing mid-restore never clobbers the record about to restore', async () => {
  const { controller, storage, script } = harness()
  writeLocalDraft(storage, 'user-1', 's1', draftRecord())
  const slowDetail = deferred<CreationApiResult<CreationSessionView>>()
  script.detail.set('s1', slowDetail)
  await flush()

  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  // The optimistic empty is "untouched" while the record restores; the
  // invariant must hold through that window.
  controller.noteManifest(seedManifest)
  assert.equal(controller.getSnapshot().draft.model, null)

  slowDetail.resolve(ok(sessionView('s1')))
  await flush()

  assert.equal(controller.getSnapshot().draft.model, 'stored-model')
  assert.equal(controller.manifestVersionForIntent(), 5)
})

test('a label update during session restore never overwrites the device draft', async () => {
  const { controller, storage, script } = harness()
  writeLocalDraft(storage, 'user-1', 's1', draftRecord())
  const slowDetail = deferred<CreationApiResult<CreationSessionView>>()
  script.detail.set('s1', slowDetail)
  await flush()

  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  controller.setMentionLabels({ image: 'Image', video: 'Video', audio: 'Audio' })

  assert.equal(readLocalDraft(storage, 'user-1', 's1')?.prompt, 'hello')

  slowDetail.resolve(ok(sessionView('s1')))
  await flush()
  assert.equal(controller.getSnapshot().draft.model, 'stored-model')
})

test('submitError derives from the current context action snapshot alone', async () => {
  const { controller, actions } = harness()
  actions.states.set('s1', { status: 'failed', code: 'model-retired' })
  await flush()

  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  await flush()
  assert.equal(controller.getSnapshot().submitError, 'model-retired')
  assert.equal(controller.getSnapshot().actionState.status, 'failed')

  // Switching away can never show another context's error.
  controller.enterContext({ kind: 'new' })
  assert.equal(controller.getSnapshot().submitError, null)

  // A runtime failure event surfaces; recovery clears it without a dismiss.
  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  await flush()
  controller.noteRuntimeEvent({ type: 'changed', sessionId: 's1' })
  assert.equal(controller.getSnapshot().submitError, 'model-retired')
  actions.states.set('s1', { status: 'idle' })
  controller.noteRuntimeEvent({ type: 'changed', sessionId: 's1' })
  assert.equal(controller.getSnapshot().submitError, null)

  // Events for other contexts never touch the displayed derivation.
  actions.states.set('s1', { status: 'failed', code: 'other' })
  controller.noteRuntimeEvent({ type: 'changed', sessionId: 's2' })
  assert.equal(controller.getSnapshot().submitError, null)
  actions.states.set('s1', { status: 'failed', code: 'model-retired' })
  controller.noteRuntimeEvent({ type: 'changed', sessionId: 's1' })
  assert.equal(controller.getSnapshot().submitError, 'model-retired')

  controller.acknowledgeActionFailure()
  assert.deepEqual(actions.acknowledged, ['s1'])
  assert.equal(controller.getSnapshot().submitError, null)
})

test('reconcileCurrentContext keeps the display when its read fails', async () => {
  const { controller, storage, script, tasks } = harness()
  writeLocalDraft(storage, 'user-1', 's1', draftRecord())
  script.materials.set('s1', ok({ materials: [materialView('m1')], nextCursor: null }))
  await flush()
  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  await flush()
  const draftBefore = controller.getSnapshot().draft

  script.detail.set('s1', { outcome: 'network-failure' })
  controller.reconcileCurrentContext()
  await flush()

  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.selectedId, 's1')
  assert.equal(snapshot.draft.model, draftBefore.model)
  assert.equal(tasks.reconcileCount, 1)
})

test('editDraft writes through under the composing surface key', async () => {
  const { controller, storage } = harness()
  await flush()
  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  await flush()

  controller.editDraft({
    ...controller.getSnapshot().draft,
    model: 'edited-model',
    promptDocument: textPromptDocument('new prompt')
  })

  const stored = readLocalDraft(storage, 'user-1', 's1')
  assert.equal(stored?.model, 'edited-model')
  assert.equal(stored?.prompt, 'new prompt')
  assert.equal(controller.getSnapshot().draft.model, 'edited-model')
})

test('claimPendingDraft moves the record off the composing key synchronously', async () => {
  const { controller, storage } = harness()
  await flush()
  controller.enterContext({ kind: 'new' })
  const draft = { ...controller.getSnapshot().draft, model: 'frozen-model' }
  controller.editDraft(draft)
  assert.notEqual(readLocalDraft(storage, 'user-1', 'new'), null)

  controller.claimPendingDraft('pending:k', draft)

  assert.equal(readLocalDraft(storage, 'user-1', 'new'), null)
  assert.equal(readLocalDraft(storage, 'user-1', 'pending:k')?.model, 'frozen-model')
  const snapshot = controller.getSnapshot()
  assert.equal(snapshot.composingNew, false)
  assert.equal(snapshot.pendingKey, 'pending:k')
})

test('restoring spans one session entry, never a background reconcile', async () => {
  const { controller, script } = harness()
  const detail = deferred<CreationApiResult<CreationSessionView>>()
  script.detail.set('s1', detail)
  await flush()
  assert.equal(controller.getSnapshot().restoring, false)

  controller.enterContext({ kind: 'session', session: sessionView('s1') })
  assert.equal(controller.getSnapshot().restoring, true)

  detail.resolve(ok(sessionView('s1')))
  await flush()
  assert.equal(controller.getSnapshot().restoring, false)

  // A background reconcile must not blink a presented workspace back to it.
  controller.reconcileCurrentContext()
  assert.equal(controller.getSnapshot().restoring, false)
  await flush()

  // A fresh draft restores from the local record synchronously, even when it
  // interrupts a session's read.
  controller.enterContext({ kind: 'session', session: sessionView('s2') })
  assert.equal(controller.getSnapshot().restoring, true)
  controller.enterContext({ kind: 'new' })
  assert.equal(controller.getSnapshot().restoring, false)
})
