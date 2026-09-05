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
  status: GenerationTaskView['status'] = 'processing'
): GenerationTaskView {
  return {
    id,
    sessionId,
    status,
    mediaType: 'image',
    slotCount: 1,
    cancelRequested: false,
    terminalCause: null,
    createdAt: '2026-09-01T09:00:00Z',
    updatedAt,
    terminalAt: null
  }
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

async function harness(sessionTasks: Record<string, GenerationTaskView[]> = {}): Promise<Harness> {
  const timers = new ManualTimers()
  const listCalls: string[] = []
  const getTaskCalls: string[] = []
  const sessions = new Map(Object.entries(sessionTasks).map(([id, tasks]) => [id, [...tasks]]))
  let listFailures = 0
  let listHangs = false
  const detailFailures = new Map<string, number>()
  const listGates: Array<Promise<void>> = []

  const reader: TaskRefreshReader = {
    listTasks: async (sessionId) => {
      listCalls.push(sessionId)
      const gate = listGates.shift()
      if (gate !== undefined) await gate
      if (listHangs) await new Promise<void>(() => undefined)
      if (listFailures > 0) {
        listFailures -= 1
        return { outcome: 'network-failure' }
      }
      return {
        outcome: 'succeeded',
        value: { tasks: sessions.get(sessionId) ?? [], nextCursor: null }
      }
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
