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

const { CreationSessionNavigationController } =
  await import('../../src/renderer/src/features/creation/model/creation-session-navigation-controller.ts')

import type {
  CreationApiResult,
  CreationSessionView,
  SessionPage
} from '../../src/renderer/src/features/creation/api/go-creation-http.ts'
import type { PendingDraftEntry } from '../../src/renderer/src/features/creation/model/creation-session-navigation-controller.ts'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const ok = <T,>(value: T): CreationApiResult<T> => ({ outcome: 'succeeded', value })

function session(id: string, name = id): CreationSessionView {
  return { id, name, createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z' }
}

class Harness {
  sessions: readonly CreationSessionView[] = [session('session-a', 'Spring campaign')]
  pending: readonly PendingDraftEntry[] = []
  listCalls = 0
  readonly controller = new CreationSessionNavigationController({
    listSessions: async (): Promise<CreationApiResult<SessionPage>> => {
      this.listCalls += 1
      return ok({ sessions: this.sessions, nextCursor: 'older-sessions-are-out-of-scope' })
    },
    renameSession: async (_sessionId, name) => ok(session('session-a', name)),
    deleteSession: async () => ok(undefined),
    pendingDrafts: () => this.pending
  })
}

test('the navigation owns one latest-session list and starts each provider run inactive', async () => {
  const firstRun = new Harness()
  firstRun.controller.activate()
  await flush()

  assert.equal(firstRun.listCalls, 1)
  assert.equal(firstRun.controller.getSnapshot().target.kind, 'inactive')
  assert.deepEqual(firstRun.controller.getSnapshot().sessions, firstRun.sessions)

  firstRun.controller.selectSession(firstRun.sessions[0])
  assert.deepEqual(firstRun.controller.getSnapshot().target, {
    kind: 'session',
    session: firstRun.sessions[0]
  })

  const restartedRun = new Harness()
  restartedRun.controller.activate()
  await flush()
  assert.equal(restartedRun.controller.getSnapshot().target.kind, 'inactive')
  assert.equal(restartedRun.listCalls, 1)
})

test('a materialized pending draft becomes the target session without a second list read', async () => {
  const harness = new Harness()
  const pending: PendingDraftEntry = {
    key: 'pending:local-draft',
    title: 'Unconfirmed prompt',
    status: 'session-unconfirmed'
  }
  harness.pending = [pending]
  harness.controller.activate()
  await flush()

  harness.controller.openPendingDraft(pending.key)
  const materialized = session('session-b', 'Materialized draft')
  harness.controller.noteSessionMaterialized(materialized, pending.key)

  assert.equal(harness.listCalls, 1)
  assert.deepEqual(harness.controller.getSnapshot().target, {
    kind: 'session',
    session: materialized
  })
  assert.deepEqual(harness.controller.getSnapshot().sessions, [materialized, ...harness.sessions])
})

test('selecting a different pending draft updates the target handoff', async () => {
  const harness = new Harness()
  const first: PendingDraftEntry = {
    key: 'pending:first',
    title: 'First submission',
    status: 'submitting'
  }
  const second: PendingDraftEntry = {
    key: 'pending:second',
    title: 'Second submission',
    status: 'session-unconfirmed'
  }
  harness.pending = [first, second]
  harness.controller.activate()
  await flush()

  harness.controller.openPendingDraft(first.key)
  harness.controller.openPendingDraft(second.key)

  assert.deepEqual(harness.controller.getSnapshot().target, { kind: 'pending', key: second.key })
})

test('a prepared session is adopted as the newest global row and target', async () => {
  const harness = new Harness()
  harness.sessions = Array.from({ length: 50 }, (_, index) => session(`session-${index}`))
  harness.controller.activate()
  await flush()

  const prepared = session('session-prepared', 'Publication reuse')
  harness.controller.adoptSession(prepared)

  assert.equal(harness.controller.getSnapshot().sessions.length, 50)
  assert.deepEqual(harness.controller.getSnapshot().sessions[0], prepared)
  assert.equal(harness.controller.getSnapshot().sessions.at(-1)?.id, 'session-48')
  assert.deepEqual(harness.controller.getSnapshot().target, { kind: 'session', session: prepared })
})
