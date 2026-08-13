import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOrdinaryCloseDecision } from '../../src/main/window/ipc/ordinary-close-contract.ts'
import { createOrdinaryCloseCoordinator } from '../../src/main/window/ordinary-close.ts'

interface CloseEvent {
  defaultPrevented: boolean
  preventDefault(): void
}

class FakeWindow {
  closeCalls = 0
  destroyed = false
  private closeListeners: Array<(event: CloseEvent) => void> = []
  private closedListeners: Array<() => void> = []

  isDestroyed(): boolean {
    return this.destroyed
  }

  on(event: 'close' | 'closed', listener: ((event: CloseEvent) => void) | (() => void)): void {
    if (event === 'close') this.closeListeners.push(listener as (event: CloseEvent) => void)
    else this.closedListeners.push(listener as () => void)
  }

  close(): void {
    this.closeCalls += 1
    this.requestClose()
  }

  requestClose(): CloseEvent {
    const event: CloseEvent = {
      defaultPrevented: false,
      preventDefault(): void {
        this.defaultPrevented = true
      }
    }
    for (const listener of this.closeListeners) listener(event)
    return event
  }

  finishClosing(): void {
    this.destroyed = true
    for (const listener of this.closedListeners) listener()
  }
}

function setup(): {
  coordinator: ReturnType<typeof createOrdinaryCloseCoordinator>
  quitCalls: () => number
  requests: ReadonlyArray<{ readonly window: FakeWindow; readonly requestId: string }>
} {
  const requestIds = ['request-1', 'request-2', 'request-3']
  let quitCalls = 0
  const requests: Array<{ window: FakeWindow; requestId: string }> = []
  const coordinator = createOrdinaryCloseCoordinator({
    createRequestId: () => requestIds.shift() ?? 'unexpected-request',
    quitApplication: () => {
      quitCalls += 1
    },
    requestDecision: (window, request) => {
      requests.push({ window: window as FakeWindow, requestId: request.requestId })
      return true
    }
  })
  return { coordinator, quitCalls: () => quitCalls, requests }
}

test('first ordinary close is held for one renderer decision and repeated close reuses it', () => {
  const { coordinator, requests } = setup()
  const window = new FakeWindow()
  coordinator.protect(window)

  assert.equal(window.requestClose().defaultPrevented, true)
  assert.deepEqual(requests, [{ window, requestId: 'request-1' }])

  assert.equal(window.requestClose().defaultPrevented, true)
  assert.equal(requests.length, 1)
})

test('an allow decision for the owning window and pending request retries close once', () => {
  const { coordinator, requests } = setup()
  const window = new FakeWindow()
  coordinator.protect(window)
  window.requestClose()

  coordinator.decide(window, { requestId: 'request-1', decision: 'allow' })

  assert.equal(window.closeCalls, 1)
  assert.equal(requests.length, 1)
})

test('cancel clears the pending request and leaves the window open', () => {
  const { coordinator, requests } = setup()
  const window = new FakeWindow()
  coordinator.protect(window)
  window.requestClose()

  coordinator.decide(window, { requestId: 'request-1', decision: 'cancel' })

  assert.equal(window.closeCalls, 0)
  assert.equal(window.isDestroyed(), false)
  window.requestClose()
  assert.deepEqual(requests.at(-1), { window, requestId: 'request-2' })
})

test('application quit intent is resumed after allow', () => {
  const { coordinator, quitCalls } = setup()
  const window = new FakeWindow()
  coordinator.protect(window)

  coordinator.requestApplicationQuit()
  window.requestClose()
  coordinator.decide(window, { requestId: 'request-1', decision: 'allow' })

  assert.equal(quitCalls(), 1)
  assert.equal(window.closeCalls, 0)
})

test('an application quit upgrades an already pending ordinary close', () => {
  const { coordinator, quitCalls, requests } = setup()
  const window = new FakeWindow()
  coordinator.protect(window)
  window.requestClose()

  coordinator.requestApplicationQuit()
  assert.equal(window.requestClose().defaultPrevented, true)
  assert.equal(requests.length, 1)
  coordinator.decide(window, { requestId: 'request-1', decision: 'allow' })

  assert.equal(quitCalls(), 1)
  assert.equal(window.closeCalls, 0)
})

test('a decision from another live window cannot consume the owning window request', () => {
  const { coordinator } = setup()
  const owner = new FakeWindow()
  const other = new FakeWindow()
  coordinator.protect(owner)
  coordinator.protect(other)
  owner.requestClose()

  assert.throws(
    () => coordinator.decide(other, { requestId: 'request-1', decision: 'allow' }),
    /does not match a pending request/
  )
  assert.equal(owner.closeCalls, 0)
  coordinator.decide(owner, { requestId: 'request-1', decision: 'cancel' })
})

test('stale and repeated decisions are rejected without changing the live window', () => {
  const { coordinator } = setup()
  const window = new FakeWindow()
  coordinator.protect(window)
  window.requestClose()

  assert.throws(
    () => coordinator.decide(window, { requestId: 'stale-request', decision: 'allow' }),
    /does not match a pending request/
  )
  coordinator.decide(window, { requestId: 'request-1', decision: 'cancel' })
  assert.throws(
    () => coordinator.decide(window, { requestId: 'request-1', decision: 'cancel' }),
    /does not match a pending request/
  )
})

const invalidDecisions = [
  undefined,
  null,
  {},
  { requestId: '', decision: 'allow' },
  { requestId: 'request-1', decision: 'later' },
  { requestId: 'request-1', decision: 'allow', extra: true }
] as const

for (const decision of invalidDecisions) {
  test(`rejects malformed close decision ${JSON.stringify(decision)}`, () => {
    assert.throws(() => parseOrdinaryCloseDecision(decision), /invalid decision payload/)
  })
}

test('a window without a live decision transport closes without being held', () => {
  const coordinator = createOrdinaryCloseCoordinator({
    createRequestId: () => 'request-1',
    quitApplication: () => undefined,
    requestDecision: () => false
  })
  const window = new FakeWindow()
  coordinator.protect(window)

  assert.equal(window.requestClose().defaultPrevented, false)
})

test('a destroyed owning window cannot decide a pending request', () => {
  const { coordinator } = setup()
  const window = new FakeWindow()
  coordinator.protect(window)
  window.requestClose()
  window.finishClosing()

  assert.throws(
    () => coordinator.decide(window, { requestId: 'request-1', decision: 'allow' }),
    /live owning window/
  )
})
