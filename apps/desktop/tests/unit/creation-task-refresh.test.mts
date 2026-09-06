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

const { TaskRefreshController } =
  await import('../../src/renderer/src/features/creation/model/task-refresh/task-refresh-controller.ts')
import type {
  TaskRefreshReader,
  TaskRefreshTimers
} from '../../src/renderer/src/features/creation/model/task-refresh/task-refresh-controller.ts'
import type {
  GenerationTaskDetail,
  GenerationTaskView
} from '../../src/renderer/src/features/creation/api/generation-task-http.ts'

/** Deterministic timers: advance() fires due one-shots and repeating ticks. */
class ManualTimers implements TaskRefreshTimers {
  private nextId = 1
  private now = 0
  private readonly repeating = new Map<number, { start: number; ms: number; fn: () => void }>()
  private readonly oneShot = new Map<number, { at: number; fn: () => void }>()

  setRepeating(callback: () => void, ms: number): number {
    const id = this.nextId
    this.nextId += 1
    this.repeating.set(id, { start: this.now, ms, fn: callback })
    return id
  }

  clearRepeating(handle: unknown): void {
    this.repeating.delete(handle as number)
  }

  setOneShot(callback: () => void, ms: number): number {
    const id = this.nextId
    this.nextId += 1
    this.oneShot.set(id, { at: this.now + ms, fn: callback })
    return id
  }

  clearOneShot(handle: unknown): void {
    this.oneShot.delete(handle as number)
  }

  advance(ms: number): void {
    const target = this.now + ms
    while (this.now < target) {
      this.now += 1
      for (const [id, shot] of [...this.oneShot]) {
        if (shot.at <= this.now) {
          this.oneShot.delete(id)
          shot.fn()
        }
      }
      for (const rep of [...this.repeating.values()]) {
        if ((this.now - rep.start) % rep.ms === 0) rep.fn()
      }
    }
  }

  get repeatingCount(): number {
    return this.repeating.size
  }
}

function taskView(
  id: string,
  sessionId: string,
  updatedAt: string,
  status: GenerationTaskView['status'] = 'processing',
  createdAt = '2026-09-01T09:00:00Z'
): GenerationTaskView {
  return {
    id,
    sessionId,
    status,
    mediaType: 'image',
    slotCount: 1,
    snapshot: null,
    cancelRequested: false,
    terminalCause: null,
    createdAt,
    updatedAt,
    terminalAt: null
  }
}

/** N tasks with distinct creation times, task N the newest (pagination fixture). */
function historyTasks(count: number, sessionId = 'A'): GenerationTaskView[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1
    const at = new Date(Date.UTC(2026, 8, 1, 9, n)).toISOString()
    return taskView(`t${String(n).padStart(2, '0')}`, sessionId, at, 'succeeded', at)
  })
}

function taskDetailOf(task: GenerationTaskView, slotStatus = 'generating'): GenerationTaskDetail {
  return {
    task,
    slots: [{ index: 0, status: slotStatus, failureReason: null, result: null }],
    specification: null
  }
}

interface Harness {
  controller: TaskRefreshController
  timers: ManualTimers
  listCalls: string[]
  /** Every list read's page request: session, limit, and continuation cursor. */
  listPageCalls: Array<{ sessionId: string; limit: number; cursor: string | null }>
  getTaskCalls: string[]
  snapshot: () => ReturnType<TaskRefreshController['getSnapshot']>
  setSession: (sessionId: string, tasks: GenerationTaskView[]) => void
  failListNext: (count: number) => void
  failDetailNext: (taskId: string, count: number) => void
  /** Defers the next list response until the returned release runs. */
  holdNextList: () => () => void
  /** Makes every list response hang until turned off. */
  setListHangs: (hangs: boolean) => void
  flush: () => void
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// The server orders pages by (created_at DESC, id DESC) with a compound
// keyset cursor (contracts listSessionGenerationTasks); the harness mirrors
// that exactly so pagination tests exercise real page semantics.
const cursorOf = (task: GenerationTaskView): string => `${task.createdAt}|${task.id}`

function newestFirst(a: GenerationTaskView, b: GenerationTaskView): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1
}

async function harness(sessionTasks: Record<string, GenerationTaskView[]> = {}): Promise<Harness> {
  const timers = new ManualTimers()
  const listCalls: string[] = []
  const listPageCalls: Array<{ sessionId: string; limit: number; cursor: string | null }> = []
  const getTaskCalls: string[] = []
  const sessions = new Map(Object.entries(sessionTasks).map(([id, tasks]) => [id, [...tasks]]))
  let listFailures = 0
  let listHangs = false
  const detailFailures = new Map<string, number>()
  const listGates: Array<Promise<void>> = []

  const reader: TaskRefreshReader = {
    listTasks: async (sessionId, page) => {
      listCalls.push(sessionId)
      listPageCalls.push({
        sessionId,
        limit: page?.limit ?? 50,
        cursor: page?.cursor ?? null
      })
      const gate = listGates.shift()
      if (gate !== undefined) await gate
      if (listHangs) await new Promise<void>(() => undefined)
      if (listFailures > 0) {
        listFailures -= 1
        return { outcome: 'network-failure' }
      }
      const all = [...(sessions.get(sessionId) ?? [])].sort(newestFirst)
      let start = 0
      if (page?.cursor) {
        const at = all.findIndex((task) => cursorOf(task) === page.cursor)
        start = at === -1 ? all.length : at + 1
      }
      const limit = page?.limit ?? 50
      const tasks = all.slice(start, start + limit)
      const nextCursor =
        tasks.length > 0 && start + tasks.length < all.length
          ? cursorOf(all[start + tasks.length - 1])
          : null
      return { outcome: 'succeeded', value: { tasks, nextCursor } }
    },
    // The server detail always reflects the latest facts for the summary the
    // list returned, mirroring the Go contract's consistent detail read.
    getTask: async (taskId) => {
      getTaskCalls.push(taskId)
      const remaining = detailFailures.get(taskId) ?? 0
      if (remaining > 0) {
        detailFailures.set(taskId, remaining - 1)
        return { outcome: 'network-failure' }
      }
      const summary = [...sessions.values()].flat().find((task) => task.id === taskId)
      if (summary === undefined) return { outcome: 'request-rejected', code: 'not_found' }
      return { outcome: 'succeeded', value: taskDetailOf(summary) }
    }
  }

  const dispatches: Array<() => void> = []
  const controller = new TaskRefreshController(reader, {
    timers,
    scheduleDispatch: (dispatch) => {
      dispatches.push(dispatch)
    }
  })

  return {
    controller,
    timers,
    listCalls,
    listPageCalls,
    getTaskCalls,
    snapshot: () => controller.getSnapshot(),
    setSession: (sessionId, tasks) => sessions.set(sessionId, [...tasks]),
    failListNext: (count) => {
      listFailures += count
    },
    failDetailNext: (taskId, count) => {
      detailFailures.set(taskId, (detailFailures.get(taskId) ?? 0) + count)
    },
    holdNextList: () => {
      let release: () => void = () => undefined
      listGates.push(
        new Promise<void>((resolve) => {
          release = resolve
        })
      )
      return release
    },
    setListHangs: (hangs) => {
      listHangs = hangs
    },
    flush: () => {
      while (dispatches.length > 0) dispatches.shift()!()
    }
  }
}

test('entry reads the list and every new detail once; unchanged details are reused', async () => {
  const t1 = taskView('t1', 'A', '2026-09-01T09:00:01.123456Z')
  const t2 = taskView('t2', 'A', '2026-09-01T09:00:02.123456Z', 'succeeded')
  const h = await harness({ A: [t1, t2] })

  h.controller.enter('A')
  h.flush()
  await settle()

  assert.deepEqual(h.listCalls, ['A'])
  assert.deepEqual([...h.getTaskCalls].sort(), ['t1', 't2'])
  assert.equal(h.snapshot().tasks.length, 2)
  assert.deepEqual(h.snapshot().taskDetails['t1'], {
    task: t1,
    slots: [{ index: 0, status: 'generating', failureReason: null, result: null }],
    specification: null
  })
  assert.equal(h.snapshot().listFailed, false)

  // Two invalidations in one tick coalesce into a single round; unchanged
  // criteria (ADR-0016 updatedAt) skip every detail re-read.
  h.controller.notifyInvalidation()
  h.controller.notifyInvalidation()
  h.flush()
  await settle()

  assert.equal(h.listCalls.length, 2)
  assert.equal(h.getTaskCalls.length, 2)
})

test('a changed criterion re-reads only that task detail', async () => {
  const t1 = taskView('t1', 'A', 'u1')
  const t2 = taskView('t2', 'A', 'u2')
  const h = await harness({ A: [t1, t2] })
  h.controller.enter('A')
  h.flush()
  await settle()
  const readsAfterEntry = h.getTaskCalls.length

  h.setSession('A', [taskView('t1', 'A', 'u1-changed'), t2])
  h.controller.notifyInvalidation()
  h.flush()
  await settle()

  assert.deepEqual(h.getTaskCalls.slice(readsAfterEntry), ['t1'])
  assert.equal(h.snapshot().taskDetails['t1']?.task.updatedAt, 'u1-changed')
})

test('a healthy stream never starts the fallback poll', async () => {
  const t1 = taskView('t1', 'A', 'u1')
  const h = await harness({ A: [t1] })
  h.controller.setStreamLive(true)
  h.controller.enter('A')
  h.flush()
  await settle()

  h.timers.advance(60_000)
  assert.equal(h.timers.repeatingCount, 0)
  assert.equal(h.listCalls.length, 1)
})

test('the fallback poll runs only while the stream is down and tasks are in progress', async () => {
  const t1 = taskView('t1', 'A', 'u1')
  const h = await harness({ A: [t1] })
  h.controller.enter('A')
  h.flush()
  await settle()
  assert.equal(h.listCalls.length, 1)

  // Stream down + in-progress task: one reconcile per 5 seconds.
  h.timers.advance(5_000)
  h.flush()
  await settle()
  assert.equal(h.listCalls.length, 2)
  h.timers.advance(5_000)
  h.flush()
  await settle()
  assert.equal(h.listCalls.length, 3)

  // The task settles: the gate closes and polling stops.
  h.setSession('A', [taskView('t1', 'A', 'u2', 'succeeded')])
  h.controller.notifyInvalidation()
  h.flush()
  await settle()
  assert.equal(h.timers.repeatingCount, 0)
  const settledCalls = h.listCalls.length
  h.timers.advance(30_000)
  h.flush()
  await settle()
  assert.equal(h.listCalls.length, settledCalls)

  // The stream recovering reconciles immediately and stays event-driven.
  h.setSession('A', [taskView('t1', 'A', 'u3', 'processing')])
  h.controller.setStreamLive(true)
  h.flush()
  await settle()
  assert.equal(h.listCalls.length, settledCalls + 1)
  assert.equal(h.timers.repeatingCount, 0)
})

test('triggers arriving mid-round merge into one follow-up round', async () => {
  const t1 = taskView('t1', 'A', 'u1')
  const h = await harness({ A: [t1] })
  const releaseList = h.holdNextList()
  h.controller.enter('A')
  h.flush()
  await settle()
  assert.equal(h.listCalls.length, 1)

  // A burst while the entry round is still in flight.
  h.controller.notifyInvalidation()
  h.controller.requestReconcile()
  h.controller.notifyInvalidation()
  h.flush()
  await settle()
  assert.equal(h.listCalls.length, 1)

  releaseList()
  await settle()
  h.flush()
  await settle()
  assert.equal(h.listCalls.length, 2)
})

test('a completed business action reconciles the displayed context immediately', async () => {
  const t1 = taskView('t1', 'A', 'u1')
  const h = await harness({ A: [t1] })
  h.controller.enter('A')
  h.flush()
  await settle()
  assert.equal(h.listCalls.length, 1)

  // The action's own response carries no display facts; the module re-reads
  // them (ADR-0005). The persisted task is part of the next round's list.
  h.setSession('A', [taskView('t2', 'A', 'u5', 'queued'), t1])
  h.controller.requestReconcile()
  h.flush()
  await settle()

  assert.equal(h.listCalls.length, 2)
  assert.deepEqual(
    h.snapshot().tasks.map((task) => task.id),
    ['t2', 't1']
  )
  assert.equal(h.snapshot().taskDetails['t2'] !== undefined, true)
})

test('A → B → A: the first A round never writes back after the switch', async () => {
  const a1 = taskView('a1', 'A', 'u1')
  const b1 = taskView('b1', 'B', 'u1')
  const h = await harness({ A: [a1], B: [b1] })
  const releaseA = h.holdNextList()
  h.controller.enter('A')
  h.flush()
  await settle()

  // A trigger merged while the held A round ran belongs to A: entering B must
  // drop it instead of leaking an extra follow-up round into the new context.
  h.controller.notifyInvalidation()
  h.controller.enter('B')
  h.flush()
  await settle()
  assert.deepEqual(
    h.snapshot().tasks.map((task) => task.id),
    ['b1']
  )
  const bCalls = h.listCalls.length
  assert.equal(bCalls, 2)

  // The first A response lands after B took over: discarded entirely.
  releaseA()
  await settle()
  h.flush()
  await settle()
  assert.equal(h.snapshot().sessionId, 'B')
  assert.deepEqual(
    h.snapshot().tasks.map((task) => task.id),
    ['b1']
  )
  assert.equal(h.listCalls.length, bCalls)
  assert.equal(h.getTaskCalls.includes('a1'), false)

  // Re-entering A reads fresh facts under new eligibility.
  h.controller.enter('A')
  h.flush()
  await settle()
  assert.deepEqual(
    h.snapshot().tasks.map((task) => task.id),
    ['a1']
  )
})

test('leave stops polling, reads, and clears the display', async () => {
  const t1 = taskView('t1', 'A', 'u1')
  const h = await harness({ A: [t1] })
  h.controller.enter('A')
  h.flush()
  await settle()

  h.controller.leave()
  assert.equal(h.snapshot().sessionId, null)
  assert.equal(h.snapshot().tasks.length, 0)
  assert.equal(h.timers.repeatingCount, 0)
  const callsAtLeave = h.listCalls.length

  h.timers.advance(30_000)
  h.controller.notifyInvalidation()
  h.flush()
  await settle()
  assert.equal(h.listCalls.length, callsAtLeave)
})

test('suspension stops everything and a re-armed controller works again', async () => {
  const t1 = taskView('t1', 'A', 'u1')
  const h = await harness({ A: [t1] })
  h.controller.enter('A')
  h.flush()
  await settle()
  assert.equal(h.snapshot().tasks.length, 1)

  // The React binding suspends on every effect cleanup (unmount and StrictMode
  // remount): reads and timers stop, and the snapshot clears.
  h.controller.suspend()
  assert.equal(h.snapshot().sessionId, null)
  assert.equal(h.timers.repeatingCount, 0)
  const callsAtSuspend = h.listCalls.length
  h.controller.notifyInvalidation()
  h.flush()
  await settle()
  assert.equal(h.listCalls.length, callsAtSuspend)

  // Re-arming (effect setup) must bring the module back — no dead instance.
  h.controller.activate()
  h.controller.enter('A')
  h.flush()
  await settle()
  assert.deepEqual(
    h.snapshot().tasks.map((task) => task.id),
    ['t1']
  )
})

test('a wedged round is bounded: the deadline frees later triggers', async () => {
  const t1 = taskView('t1', 'A', 'u1')
  const h = await harness({ A: [t1] })
  h.setListHangs(true)
  h.controller.enter('A')
  h.flush()
  await settle()
  assert.equal(h.snapshot().listFailed, false)

  h.timers.advance(30_000)
  assert.equal(h.snapshot().listFailed, true)

  // The hung response no longer blocks: a fresh trigger starts a new round.
  h.setListHangs(false)
  h.controller.notifyInvalidation()
  h.flush()
  await settle()
  assert.equal(h.listCalls.length, 2)
  assert.deepEqual(
    h.snapshot().tasks.map((task) => task.id),
    ['t1']
  )
  assert.equal(h.snapshot().listFailed, false)
})

test('a failed detail read keeps the last consistent copy and is retried', async () => {
  const t1 = taskView('t1', 'A', 'u1')
  const h = await harness({ A: [t1] })
  h.controller.enter('A')
  h.flush()
  await settle()
  const consistent = h.snapshot().taskDetails['t1']
  assert.ok(consistent !== undefined)

  h.setSession('A', [taskView('t1', 'A', 'u2')])
  h.failDetailNext('t1', 1)
  h.controller.notifyInvalidation()
  h.flush()
  await settle()

  assert.equal(h.snapshot().taskDetails['t1'], consistent)
  assert.equal(h.snapshot().staleTaskIds.has('t1'), true)

  h.controller.notifyInvalidation()
  h.flush()
  await settle()
  assert.equal(h.snapshot().taskDetails['t1']?.task.updatedAt, 'u2')
  assert.equal(h.snapshot().staleTaskIds.has('t1'), false)
})

test('a new task whose detail fails shows a placeholder marked unrefreshed, not absence', async () => {
  const h = await harness({ A: [] })
  h.controller.enter('A')
  h.flush()
  await settle()

  const fresh = taskView('t-new', 'A', 'u9')
  h.setSession('A', [fresh])
  h.failDetailNext('t-new', 1)
  h.controller.notifyInvalidation()
  h.flush()
  await settle()

  assert.deepEqual(
    h.snapshot().tasks.map((task) => task.id),
    ['t-new']
  )
  assert.equal(h.snapshot().taskDetails['t-new'], undefined)
  assert.equal(h.snapshot().staleTaskIds.has('t-new'), true)
  assert.equal(h.snapshot().listFailed, false)
})

test('one task failing does not block another task in the same round', async () => {
  const t1 = taskView('t1', 'A', 'u1')
  const t2 = taskView('t2', 'A', 'u2')
  const h = await harness({ A: [t1, t2] })
  h.controller.enter('A')
  h.flush()
  await settle()

  h.setSession('A', [taskView('t1', 'A', 'u1x'), taskView('t2', 'A', 'u2x')])
  h.failDetailNext('t1', 1)
  h.controller.notifyInvalidation()
  h.flush()
  await settle()

  assert.equal(h.snapshot().taskDetails['t2']?.task.updatedAt, 'u2x')
  assert.equal(h.snapshot().staleTaskIds.has('t1'), true)
  assert.equal(h.snapshot().staleTaskIds.has('t2'), false)
})

test('a failed list read keeps loaded tasks and marks the list unrefreshed', async () => {
  const t1 = taskView('t1', 'A', 'u1')
  const h = await harness({ A: [t1] })
  h.controller.enter('A')
  h.flush()
  await settle()

  h.failListNext(1)
  h.controller.notifyInvalidation()
  h.flush()
  await settle()

  assert.deepEqual(
    h.snapshot().tasks.map((task) => task.id),
    ['t1']
  )
  assert.equal(h.snapshot().taskDetails['t1'] !== undefined, true)
  assert.equal(h.snapshot().listFailed, true)

  h.controller.notifyInvalidation()
  h.flush()
  await settle()
  assert.equal(h.snapshot().listFailed, false)
})

test('tasks falling outside the latest window stay displayed with their details', async () => {
  const t1 = taskView('t1', 'A', 'u1')
  const t2 = taskView('t2', 'A', 'u2')
  const h = await harness({ A: [t1, t2] })
  h.controller.enter('A')
  h.flush()
  await settle()

  // Only t2 remains inside the window; t1 fell behind it, not deleted.
  h.setSession('A', [t2])
  h.controller.notifyInvalidation()
  h.flush()
  await settle()

  assert.deepEqual(
    h.snapshot().tasks.map((task) => task.id),
    ['t2', 't1']
  )
  assert.equal(h.snapshot().taskDetails['t1'] !== undefined, true)
  const readsBefore = h.getTaskCalls.filter((id) => id === 't1').length
  assert.equal(readsBefore, 1)

  // A further round does not re-read the out-of-window task.
  h.controller.notifyInvalidation()
  h.flush()
  await settle()
  assert.equal(h.getTaskCalls.filter((id) => id === 't1').length, 1)
})

// --- upward history pagination (issue #195) ----------------------------------

test('entry reads the newest 20 as one windowed page with the older cursor', async () => {
  const h = await harness({ A: historyTasks(45) })
  h.controller.enter('A')
  h.flush()
  await settle()

  assert.deepEqual(h.listPageCalls, [{ sessionId: 'A', limit: 20, cursor: null }])
  assert.deepEqual(
    h.snapshot().tasks.map((task) => task.id),
    Array.from({ length: 20 }, (_, i) => `t${String(45 - i).padStart(2, '0')}`)
  )
  assert.equal(h.snapshot().history.hasMore, true)
  assert.equal(h.snapshot().history.loading, false)
  assert.equal(h.snapshot().history.failed, false)
})

test('requestOlderTasks pages history in 20s until exhaustion, reading only fresh details', async () => {
  const h = await harness({ A: historyTasks(45) })
  h.controller.enter('A')
  h.flush()
  await settle()

  h.controller.requestOlderTasks()
  h.flush()
  await settle()
  assert.equal(h.snapshot().tasks.length, 40)
  assert.equal(h.snapshot().history.hasMore, true)
  // The older page continues from the window tail's keyset cursor.
  assert.deepEqual(h.listPageCalls[1], {
    sessionId: 'A',
    limit: 20,
    cursor: '2026-09-01T09:26:00.000Z|t26'
  })

  h.controller.requestOlderTasks()
  h.flush()
  await settle()
  assert.equal(h.snapshot().tasks.length, 45)
  assert.equal(h.snapshot().history.hasMore, false)

  // Exhausted: no further read, and the whole history was detailed once.
  const callsBefore = h.listCalls.length
  h.controller.requestOlderTasks()
  h.flush()
  await settle()
  assert.equal(h.listCalls.length, callsBefore)
  assert.deepEqual(
    [...h.getTaskCalls].sort(),
    Array.from({ length: 45 }, (_, i) => `t${String(i + 1).padStart(2, '0')}`).sort()
  )
  // Global order stays newest-first across all three pages.
  assert.deepEqual(
    h.snapshot().tasks.map((task) => task.id),
    Array.from({ length: 45 }, (_, i) => `t${String(45 - i).padStart(2, '0')}`)
  )
})

test('a failed older-page read keeps loaded pages, stays retryable, and retries', async () => {
  const h = await harness({ A: historyTasks(45) })
  h.controller.enter('A')
  h.flush()
  await settle()
  const loaded = h.snapshot().tasks.map((task) => task.id)

  h.failListNext(1)
  h.controller.requestOlderTasks()
  h.flush()
  await settle()

  assert.deepEqual(
    h.snapshot().tasks.map((task) => task.id),
    loaded
  )
  assert.equal(h.snapshot().history.failed, true)
  assert.equal(h.snapshot().history.hasMore, true)
  assert.equal(h.snapshot().listFailed, false)

  // The retry continues from the same cursor and lands the page.
  h.controller.requestOlderTasks()
  h.flush()
  await settle()
  assert.equal(h.snapshot().tasks.length, 40)
  assert.equal(h.snapshot().history.failed, false)
})

test('a history intent during a window round continues after it, and a refresh during a history round is not lost', async () => {
  const h = await harness({ A: historyTasks(45) })
  h.controller.enter('A')
  h.flush()
  await settle()

  // A window refresh is in flight when the older-page intent arrives: the
  // refresh finishes first, then exactly one history round continues.
  const releaseWindow = h.holdNextList()
  h.controller.notifyInvalidation()
  h.flush()
  await settle()
  h.controller.requestOlderTasks()
  releaseWindow()
  await settle()
  h.flush()
  await settle()

  assert.equal(h.listCalls.length, 3)
  assert.equal(h.snapshot().tasks.length, 40)

  // Now the reverse interleave: a history round in flight receives a refresh.
  const releaseHistory = h.holdNextList()
  h.controller.requestOlderTasks()
  h.flush()
  await settle()
  assert.equal(h.snapshot().history.loading, true)
  h.controller.requestReconcile()
  releaseHistory()
  await settle()
  h.flush()
  await settle()

  assert.equal(h.snapshot().tasks.length, 45)
  assert.equal(h.listCalls.length, 5)
})

test('new tasks arriving between pages keep the older-page continuation seamless', async () => {
  const all = historyTasks(45)
  const h = await harness({ A: all })
  h.controller.enter('A')
  h.flush()
  await settle()

  // Five brand-new tasks land; the window refresh keeps the five tasks that
  // fell behind it, so history must continue from the original window tail.
  const fresh = historyTasks(50).slice(45)
  h.setSession('A', [...fresh, ...all])
  h.controller.notifyInvalidation()
  h.flush()
  await settle()
  assert.equal(h.snapshot().tasks.length, 25)

  h.controller.requestOlderTasks()
  h.flush()
  await settle()
  const ids = h.snapshot().tasks.map((task) => task.id)
  assert.equal(ids.length, 45)
  assert.equal(new Set(ids).size, 45)
  assert.deepEqual(
    ids.slice(0, 20),
    Array.from({ length: 20 }, (_, i) => `t${String(50 - i).padStart(2, '0')}`)
  )
  assert.deepEqual(ids.slice(20, 25), ['t30', 't29', 't28', 't27', 't26'])
  assert.deepEqual(
    ids.slice(25),
    Array.from({ length: 20 }, (_, i) => `t${String(25 - i).padStart(2, '0')}`)
  )
})

test('same-created tasks keep one stable order across page boundaries', async () => {
  // One shared creation second: the (created_at DESC, id DESC) keyset order
  // must not reshuffle when a boundary cuts through it.
  const shared = '2026-09-01T09:00:00Z'
  const tasks = Array.from({ length: 45 }, (_, index) =>
    taskView(`t${String(index + 1).padStart(2, '0')}`, 'A', 'u', 'succeeded', shared)
  )
  const expected = [...tasks]
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .map((t) => t.id)

  const h = await harness({ A: tasks })
  h.controller.enter('A')
  h.flush()
  await settle()
  h.controller.requestOlderTasks()
  h.flush()
  await settle()
  h.controller.requestOlderTasks()
  h.flush()
  await settle()

  assert.deepEqual(
    h.snapshot().tasks.map((task) => task.id),
    expected
  )
})

test('a wedged history round expires to a retryable failure without losing pages', async () => {
  const h = await harness({ A: historyTasks(45) })
  h.controller.enter('A')
  h.flush()
  await settle()

  h.setListHangs(true)
  h.controller.requestOlderTasks()
  h.flush()
  await settle()
  assert.equal(h.snapshot().history.loading, true)

  h.timers.advance(30_000)
  assert.equal(h.snapshot().history.loading, false)
  assert.equal(h.snapshot().history.failed, true)
  assert.equal(h.snapshot().tasks.length, 20)

  h.setListHangs(false)
  h.controller.requestOlderTasks()
  h.flush()
  await settle()
  assert.equal(h.snapshot().tasks.length, 40)
  assert.equal(h.snapshot().history.failed, false)
})

test('a changed task inside the newest window updates in place without duplicating loaded history', async () => {
  const h = await harness({ A: historyTasks(25) })
  h.controller.enter('A')
  h.flush()
  await settle()
  h.controller.requestOlderTasks()
  h.flush()
  await settle()
  assert.equal(h.snapshot().tasks.length, 25)
  assert.equal(h.snapshot().history.hasMore, false)
  const readsBefore = h.getTaskCalls.length

  // t10 sits inside the newest window and already has a cached detail; its
  // criterion changes and the older pages must stay exactly where they were.
  h.setSession(
    'A',
    historyTasks(25).map((task) => (task.id === 't10' ? { ...task, updatedAt: 'u-changed' } : task))
  )
  h.controller.notifyInvalidation()
  h.flush()
  await settle()

  const ids = h.snapshot().tasks.map((task) => task.id)
  assert.equal(new Set(ids).size, 25)
  assert.equal(h.snapshot().taskDetails['t10']?.task.updatedAt, 'u-changed')
  assert.deepEqual(h.getTaskCalls.slice(readsBefore), ['t10'])
})

test('entering a session resets history pagination state', async () => {
  const h = await harness({ A: historyTasks(45), B: historyTasks(3) })
  h.controller.enter('A')
  h.flush()
  await settle()
  h.controller.requestOlderTasks()
  h.flush()
  await settle()
  assert.equal(h.snapshot().tasks.length, 40)

  h.controller.enter('B')
  h.flush()
  await settle()
  assert.equal(h.snapshot().tasks.length, 3)
  assert.equal(h.snapshot().history.hasMore, false)
  assert.equal(h.snapshot().history.failed, false)

  // Re-entering A starts from its newest window again under new eligibility.
  h.controller.enter('A')
  h.flush()
  await settle()
  assert.equal(h.snapshot().tasks.length, 20)
  assert.equal(h.snapshot().history.hasMore, true)
})

test('a change to a history-loaded task outside the window never re-reads or reorders it', async () => {
  const h = await harness({ A: historyTasks(45) })
  h.controller.enter('A')
  h.flush()
  await settle()
  h.controller.requestOlderTasks()
  h.flush()
  await settle()
  h.controller.requestOlderTasks()
  h.flush()
  await settle()
  assert.equal(h.snapshot().tasks.length, 45)
  const t03ReadsBefore = h.getTaskCalls.filter((id) => id === 't03').length
  const t03Detail = h.snapshot().taskDetails['t03']

  // t03 lives in the oldest loaded page, far behind the newest window: no
  // fresh summary criterion can vouch for it, so its cached detail stays the
  // last consistent copy (spec #189 §7) instead of being guessed refreshed.
  h.setSession(
    'A',
    historyTasks(45).map((task) => (task.id === 't03' ? { ...task, updatedAt: 'u-changed' } : task))
  )
  h.controller.notifyInvalidation()
  h.flush()
  await settle()

  assert.equal(h.snapshot().taskDetails['t03'], t03Detail)
  assert.equal(h.getTaskCalls.filter((id) => id === 't03').length, t03ReadsBefore)
  assert.deepEqual(
    h.snapshot().tasks.map((task) => task.id),
    Array.from({ length: 45 }, (_, i) => `t${String(45 - i).padStart(2, '0')}`)
  )
})
