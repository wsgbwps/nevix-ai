/**
 * The Generation Task refresh module's engine (ADR-0005): it owns task
 * list/detail reading, refresh scheduling, trigger coalescing, stale-result
 * invalidation, and per-task consistent display state for the currently
 * displayed Creation Session. It never issues business commands — business
 * actions only ask it to reconcile (re-read server facts).
 *
 * The controller is framework-free so its scheduling invariants — one
 * in-flight read round per display lifecycle, coalesced triggers, entry
 * epochs, and the fallback poll gate — are testable against scripted ports
 * and an injected clock.
 */
import { isTerminalTaskStatus } from '../../api/generation-task-http'
import type {
  GenerationTaskDetail,
  GenerationTaskView,
  TaskPage
} from '../../api/generation-task-http'
import type { CreationApiResult } from '../../api/go-creation-http'

/** The read-only task seam this module consumes; no submit/cancel/retry. */
export interface TaskRefreshReader {
  readonly listTasks: (sessionId: string) => Promise<CreationApiResult<TaskPage>>
  readonly getTask: (taskId: string) => Promise<CreationApiResult<GenerationTaskDetail>>
}

/** What the gallery renders for the displayed Creation Session. */
export interface TaskRefreshSnapshot {
  /** The session this display lifecycle shows; null when no context is entered. */
  readonly sessionId: string | null
  /** Task summaries newest-first: the latest server window merged with previously loaded tasks. */
  readonly tasks: readonly GenerationTaskView[]
  readonly taskDetails: Readonly<Record<string, GenerationTaskDetail>>
  /** Tasks whose latest detail read failed: the last consistent copy stays, marked unrefreshed. */
  readonly staleTaskIds: ReadonlySet<string>
  /** True when the latest list read failed; kept tasks stay and nothing masquerades as fresh. */
  readonly listFailed: boolean
}

export const emptyTaskRefreshSnapshot: TaskRefreshSnapshot = {
  sessionId: null,
  tasks: [],
  taskDetails: {},
  staleTaskIds: new Set<string>(),
  listFailed: false
}

/** Injected scheduling primitives; production wraps the globals, tests drive them manually. */
export interface TaskRefreshTimers {
  readonly setRepeating: (callback: () => void, ms: number) => unknown
  readonly clearRepeating: (handle: unknown) => void
  readonly setOneShot: (callback: () => void, ms: number) => unknown
  readonly clearOneShot: (handle: unknown) => void
}

export interface TaskRefreshOptions {
  readonly pollIntervalMs?: number
  readonly roundDeadlineMs?: number
  readonly timers?: TaskRefreshTimers
  /** Batches same-tick triggers into one round; defaults to the microtask queue. */
  readonly scheduleDispatch?: (dispatch: () => void) => void
}

// The disconnection fallback cadence (ADR-0005): while the SSE stream is down
// and the displayed session holds in-progress tasks, reconcile every 5 seconds.
const DEFAULT_POLL_INTERVAL_MS = 5_000

// A local recovery bound for a wedged read round, not a per-request timeout:
// it must outlast a healthy round (one windowed list read plus its parallel
// detail reads) while guaranteeing that a hung response can never permanently
// block the next reconciliation. It is deliberately not 5s — the ~10s recovery
// target covers discovering a dropped stream or a reconnect, which the poll
// cadence and immediate reconnect reconcile already satisfy.
const DEFAULT_ROUND_DEADLINE_MS = 30_000

const defaultTimers: TaskRefreshTimers = {
  setRepeating: (callback, ms) => setInterval(callback, ms),
  clearRepeating: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setOneShot: (callback, ms) => setTimeout(callback, ms),
  clearOneShot: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** One cached detail paired with the change criterion of the exact response it
 * came from (ADR-0016: `updatedAt` read as the full wire string), so a list
 * summary can never vouch for a detail it did not arrive with. */
interface CachedDetail {
  readonly detail: GenerationTaskDetail
  readonly criterion: string
}

/** The single read round allowed in flight per display lifecycle. */
interface ActiveRound {
  readonly sessionId: string
  listSettled: boolean
  readonly pendingDetails: Set<string>
}

export class TaskRefreshController {
  private readonly reader: TaskRefreshReader
  private readonly pollIntervalMs: number
  private readonly roundDeadlineMs: number
  private readonly timers: TaskRefreshTimers
  private readonly scheduleDispatch: (dispatch: () => void) => void

  private snapshot: TaskRefreshSnapshot = emptyTaskRefreshSnapshot
  private readonly listeners = new Set<() => void>()

  // Display eligibility is round identity: entering or leaving retires the
  // active round, and every read compares against the current active round
  // before writing back — the second A in A → B → A never accepts the first
  // A's reads (ADR-0005).
  private enteredSessionId: string | null = null
  private streamLive = false
  private activeRound: ActiveRound | null = null
  private pendingFollowUp = false
  private dispatchScheduled = false
  private pollHandle: unknown = null
  private deadlineHandle: unknown = null
  private suspended = false

  // Display caches for the entered session, reset on every enter().
  private summaries: readonly GenerationTaskView[] = []
  private readonly details = new Map<string, CachedDetail>()
  private readonly failedDetailIds = new Set<string>()
  private listFailedFlag = false

  constructor(reader: TaskRefreshReader, options: TaskRefreshOptions = {}) {
    this.reader = reader
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.roundDeadlineMs = options.roundDeadlineMs ?? DEFAULT_ROUND_DEADLINE_MS
    this.timers = options.timers ?? defaultTimers
    this.scheduleDispatch = options.scheduleDispatch ?? ((dispatch) => queueMicrotask(dispatch))
  }

  /** A new display lifecycle for one Creation Session — even re-entering the
   * same id — with fresh eligibility, fresh caches, and an immediate
   * reconciliation round. */
  enter(sessionId: string): void {
    if (this.suspended) return
    this.retireActiveRound()
    // A trigger merged while the retired round ran belongs to the previous
    // context; the entry round below is the new lifecycle's own read.
    this.pendingFollowUp = false
    this.enteredSessionId = sessionId
    this.resetDisplayState()
    this.commit()
    this.requestRefresh()
  }

  /** Ends the display lifecycle: the task view clears, no further reads
   * start, timers stop, and in-flight responses lose eligibility. */
  leave(): void {
    if (this.suspended) return
    this.retireActiveRound()
    this.enteredSessionId = null
    this.pendingFollowUp = false
    this.dispatchScheduled = false
    this.resetDisplayState()
    this.commit()
  }

  /** Stops the module entirely — reads, timers, eligibility — leaving an
   * empty snapshot. Reversible: the React binding re-arms on every effect
   * run, so React StrictMode's dev-only remount cannot leave a dead module. */
  suspend(): void {
    if (this.suspended) return
    this.suspended = true
    this.retireActiveRound()
    this.enteredSessionId = null
    this.pendingFollowUp = false
    this.dispatchScheduled = false
    if (this.pollHandle !== null) {
      this.timers.clearRepeating(this.pollHandle)
      this.pollHandle = null
    }
    this.resetDisplayState()
    this.commit()
  }

  activate(): void {
    this.suspended = false
  }

  /** An SSE creation-invalidation block: the stream only hints that server
   * facts changed; the round re-reads them. */
  notifyInvalidation(): void {
    this.requestRefresh()
  }

  /** SSE liveness. Every down → up transition reconciles immediately — the
   * server does not replay notifications a lost stream missed. */
  setStreamLive(live: boolean): void {
    if (this.suspended || live === this.streamLive) return
    this.streamLive = live
    this.reconcilePollGate()
    if (live) this.requestRefresh()
  }

  /** A business action completed somewhere that still owns this display;
   * completions for un-displayed contexts never reach the module. */
  requestReconcile(): void {
    this.requestRefresh()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot(): TaskRefreshSnapshot {
    return this.snapshot
  }

  // --- scheduling -----------------------------------------------------------

  private requestRefresh(): void {
    if (this.suspended || this.enteredSessionId === null) return
    if (this.activeRound !== null) {
      // At most one round in flight: every trigger arriving mid-round merges
      // into one follow-up reconciliation, so bursts never fan out.
      this.pendingFollowUp = true
      return
    }
    if (this.dispatchScheduled) return
    this.dispatchScheduled = true
    this.scheduleDispatch(() => {
      this.dispatchScheduled = false
      this.startRound()
    })
  }

  private startRound(): void {
    if (this.suspended || this.enteredSessionId === null || this.activeRound !== null) return
    const round: ActiveRound = {
      sessionId: this.enteredSessionId,
      listSettled: false,
      pendingDetails: new Set<string>()
    }
    this.activeRound = round
    this.deadlineHandle = this.timers.setOneShot(
      () => this.expireRound(round),
      this.roundDeadlineMs
    )
    void this.runRound(round)
  }

  private async runRound(round: ActiveRound): Promise<void> {
    let page: TaskPage | null = null
    try {
      const result = await this.reader.listTasks(round.sessionId)
      if (result.outcome === 'succeeded') page = result.value
    } catch {
      page = null
    }
    if (this.activeRound !== round) return
    round.listSettled = true
    if (page === null) {
      // The list read failed: keep every loaded task and detail, and mark the
      // list unrefreshed — a failed round must never look like an empty or
      // deleted history.
      this.listFailedFlag = true
      this.commit()
      this.finishRound(round)
      return
    }
    // The latest window is not the session's whole task set: tasks it no
    // longer lists stay displayed (and keep their cached details) instead of
    // being inferred deleted. Their position stays behind the window.
    const windowIds = new Set(page.tasks.map((task) => task.id))
    const kept = this.summaries.filter((task) => !windowIds.has(task.id))
    this.summaries = [...page.tasks, ...kept]
    this.listFailedFlag = false
    this.commit()
    // Incremental detail reads: only tasks the fresh window covers have a
    // fresh criterion, so only they are re-read (new, changed per ADR-0016's
    // `updatedAt` contract, or previously failed). Each read commits on its
    // own — one task's failure never blocks the others.
    const reads: Promise<void>[] = []
    for (const summary of page.tasks) {
      if (!this.needsDetailRead(summary)) continue
      round.pendingDetails.add(summary.id)
      reads.push(this.readDetail(round, summary.id))
    }
    await Promise.all(reads)
    if (this.activeRound !== round) return
    this.finishRound(round)
  }

  private async readDetail(round: ActiveRound, taskId: string): Promise<void> {
    let detail: GenerationTaskDetail | null = null
    try {
      const result = await this.reader.getTask(taskId)
      if (result.outcome === 'succeeded') detail = result.value
    } catch {
      detail = null
    }
    if (this.activeRound !== round) return
    round.pendingDetails.delete(taskId)
    if (detail === null) {
      // Keep the task's last consistent detail (if any) and mark it
      // unrefreshed; the next round retries it.
      this.failedDetailIds.add(taskId)
      this.commit()
      return
    }
    this.failedDetailIds.delete(taskId)
    this.details.set(taskId, { detail, criterion: detail.task.updatedAt })
    this.commit()
  }

  private needsDetailRead(summary: GenerationTaskView): boolean {
    if (this.failedDetailIds.has(summary.id)) return true
    const cached = this.details.get(summary.id)
    if (cached === undefined) return true
    return summary.updatedAt !== cached.criterion
  }

  private finishRound(round: ActiveRound): void {
    if (this.activeRound === round) {
      if (this.deadlineHandle !== null) this.timers.clearOneShot(this.deadlineHandle)
      this.deadlineHandle = null
      this.activeRound = null
    }
    this.runMergedFollowUp()
  }

  private expireRound(round: ActiveRound): void {
    if (this.activeRound !== round) return
    this.deadlineHandle = null
    this.activeRound = null
    // Whatever the round never received counts as failed; its late responses
    // are discarded by the round check, and the merged follow-up (or any
    // later trigger) starts fresh.
    let changed = false
    if (!round.listSettled) {
      this.listFailedFlag = true
      changed = true
    }
    for (const taskId of round.pendingDetails) {
      this.failedDetailIds.add(taskId)
      changed = true
    }
    round.pendingDetails.clear()
    if (changed) this.commit()
    this.runMergedFollowUp()
  }

  private runMergedFollowUp(): void {
    if (!this.pendingFollowUp) return
    this.pendingFollowUp = false
    this.startRound()
  }

  private retireActiveRound(): void {
    if (this.activeRound === null) return
    if (this.deadlineHandle !== null) this.timers.clearOneShot(this.deadlineHandle)
    this.deadlineHandle = null
    this.activeRound = null
  }

  private resetDisplayState(): void {
    this.summaries = []
    this.details.clear()
    this.failedDetailIds.clear()
    this.listFailedFlag = false
  }

  private reconcilePollGate(): void {
    // The fallback poll runs only while the stream is down AND the displayed
    // session itself holds in-progress tasks; a healthy stream is purely
    // event-driven and a quiet session never polls.
    const shouldPoll =
      !this.suspended &&
      this.enteredSessionId !== null &&
      !this.streamLive &&
      this.snapshot.tasks.some((task) => !isTerminalTaskStatus(task.status))
    if (shouldPoll && this.pollHandle === null) {
      this.pollHandle = this.timers.setRepeating(() => {
        this.requestRefresh()
      }, this.pollIntervalMs)
    } else if (!shouldPoll && this.pollHandle !== null) {
      this.timers.clearRepeating(this.pollHandle)
      this.pollHandle = null
    }
  }

  // --- state ----------------------------------------------------------------

  private commit(): void {
    const taskDetails: Record<string, GenerationTaskDetail> = {}
    for (const [taskId, cached] of this.details) taskDetails[taskId] = cached.detail
    this.snapshot = {
      sessionId: this.enteredSessionId,
      tasks: [...this.summaries],
      taskDetails,
      staleTaskIds: new Set(this.failedDetailIds),
      listFailed: this.listFailedFlag
    }
    for (const listener of this.listeners) listener()
    // Snapshot changes can flip the poll gate (terminal tasks, kept tasks).
    this.reconcilePollGate()
  }
}
