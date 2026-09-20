import type { CreationApiResult, CreationSessionView, SessionPage } from '../api/go-creation-http'
import type { WorkbenchActionState } from './workbench-runtime'

const LATEST_SESSION_LIMIT = 50

export type CreationSessionNavigationStatus = 'loading' | 'ready' | 'error'

export type CreationSessionNavigationTarget =
  | { readonly kind: 'session'; readonly session: CreationSessionView }
  | { readonly kind: 'pending'; readonly key: string }
  | { readonly kind: 'new' }
  | { readonly kind: 'inactive' }

/** A submitted local Draft that has not yet acquired a Creation Session identity. */
export interface PendingDraftEntry {
  readonly key: string
  readonly title: string
  readonly status: WorkbenchActionState['status']
}

export interface CreationSessionNavigationSnapshot {
  readonly status: CreationSessionNavigationStatus
  readonly sessions: readonly CreationSessionView[]
  readonly pendingDrafts: readonly PendingDraftEntry[]
  readonly target: CreationSessionNavigationTarget
}

export const emptyCreationSessionNavigationSnapshot: CreationSessionNavigationSnapshot = {
  status: 'loading',
  sessions: [],
  pendingDrafts: [],
  target: { kind: 'inactive' }
}

export interface CreationSessionNavigationDeps {
  readonly listSessions: () => Promise<CreationApiResult<SessionPage>>
  readonly renameSession: (
    sessionId: string,
    name: string
  ) => Promise<CreationApiResult<CreationSessionView>>
  readonly deleteSession: (sessionId: string) => Promise<CreationApiResult<void>>
  readonly pendingDrafts: () => readonly PendingDraftEntry[]
}

/**
 * The route-above Creation Session Navigation owner (ADR-0007): the latest
 * session page and the one target handed to the route-local Workbench. It
 * deliberately has no task, material, or display dependency.
 */
export class CreationSessionNavigationController {
  readonly #deps: CreationSessionNavigationDeps
  readonly #listeners = new Set<() => void>()
  #active = false
  #loadEpoch = 0
  #status: CreationSessionNavigationStatus = 'loading'
  #sessions: readonly CreationSessionView[] = []
  #pendingDrafts: readonly PendingDraftEntry[] = []
  #target: CreationSessionNavigationTarget = { kind: 'inactive' }
  #snapshot: CreationSessionNavigationSnapshot = emptyCreationSessionNavigationSnapshot

  constructor(deps: CreationSessionNavigationDeps) {
    this.#deps = deps
  }

  activate(): void {
    this.#active = true
    this.#refreshPendingDrafts()
    void this.#loadSessions()
  }

  suspend(): void {
    this.#active = false
    this.#loadEpoch += 1
  }

  subscribe(notify: () => void): () => void {
    this.#listeners.add(notify)
    return () => this.#listeners.delete(notify)
  }

  getSnapshot(): CreationSessionNavigationSnapshot {
    return this.#snapshot
  }

  reload(): void {
    void this.#loadSessions()
  }

  refreshPendingDrafts(): void {
    this.#refreshPendingDrafts()
    this.#changed()
  }

  selectSession(session: CreationSessionView): void {
    this.#setTarget({ kind: 'session', session })
  }

  /** A server-created session arrives outside list reconciliation, such as Publication reuse. */
  adoptSession(session: CreationSessionView): void {
    this.#setSessions(this.#prependSession(session))
    this.#setTarget({ kind: 'session', session })
  }

  openPendingDraft(key: string): void {
    this.#setTarget({ kind: 'pending', key })
  }

  startNewDraft(): void {
    this.#setTarget({ kind: 'new' })
  }

  deleteSession(sessionId: string): void {
    void (async () => {
      const result = await this.#deps.deleteSession(sessionId)
      if (result.outcome !== 'succeeded' || !this.#active) return
      this.#setSessions(this.#sessions.filter((session) => session.id !== sessionId))
      if (this.#target.kind === 'session' && this.#target.session.id === sessionId) {
        this.#target = { kind: 'inactive' }
      }
      this.#changed()
    })()
  }

  renameSession(sessionId: string, name: string): void {
    this.#setSessions(
      this.#sessions.map((session) => (session.id === sessionId ? { ...session, name } : session))
    )
    void this.#deps.renameSession(sessionId, name).catch(() => undefined)
    this.#changed()
  }

  /** A pending Draft has received its server identity while the Workbench may be unmounted. */
  noteSessionMaterialized(session: CreationSessionView, pendingKey: string): void {
    this.#loadEpoch += 1
    this.#status = 'ready'
    this.#setSessions(this.#prependSession(session))
    this.#refreshPendingDrafts()
    if (this.#target.kind === 'pending' && this.#target.key === pendingKey) {
      this.#target = { kind: 'session', session }
    }
    this.#changed()
  }

  async #loadSessions(): Promise<void> {
    const epoch = ++this.#loadEpoch
    const result = await this.#deps.listSessions().catch(() => null)
    if (!this.#active || epoch !== this.#loadEpoch) return
    if (result !== null && result.outcome === 'succeeded') {
      this.#status = 'ready'
      this.#setSessions(result.value.sessions)
    } else {
      this.#status = 'error'
    }
    this.#refreshPendingDrafts()
    this.#changed()
  }

  #setSessions(sessions: readonly CreationSessionView[]): void {
    this.#sessions = sessions
    if (this.#target.kind !== 'session') return
    const targetId = this.#target.session.id
    const target = sessions.find((session) => session.id === targetId)
    this.#target =
      target === undefined ? { kind: 'inactive' } : { kind: 'session', session: target }
  }

  #prependSession(session: CreationSessionView): readonly CreationSessionView[] {
    return [session, ...this.#sessions.filter((entry) => entry.id !== session.id)].slice(
      0,
      LATEST_SESSION_LIMIT
    )
  }

  #refreshPendingDrafts(): void {
    this.#pendingDrafts = this.#deps.pendingDrafts()
  }

  #setTarget(target: CreationSessionNavigationTarget): void {
    const current = this.#target
    if (
      current.kind === target.kind &&
      (current.kind !== 'session' ||
        target.kind !== 'session' ||
        current.session.id === target.session.id) &&
      (current.kind !== 'pending' || target.kind !== 'pending' || current.key === target.key)
    ) {
      if (current.kind === 'session' && target.kind === 'session') {
        this.#target = target
        this.#changed()
      }
      return
    }
    this.#target = target
    this.#changed()
  }

  #changed(): void {
    this.#snapshot = {
      status: this.#status,
      sessions: this.#sessions,
      pendingDrafts: this.#pendingDrafts,
      target: this.#target
    }
    for (const notify of [...this.#listeners]) notify()
  }
}
