/**
 * The in-memory Session persistence adapter for Authentication-owned test
 * composition. Tests script outcomes, deferred completions, and completion
 * order; every call is recorded so tests can assert persistence degradation
 * and ordering. An unscripted call rejects loudly — a test must never touch
 * real storage.
 */
import type { SessionCredentials } from '../api/go-authentication'
import type {
  SessionClearance,
  SessionPersistence,
  SessionReplacement,
  StoredSessionRead
} from './session-persistence'

export type SessionPersistenceCall =
  | { readonly operation: 'read' }
  | { readonly operation: 'replace'; readonly session: SessionCredentials }
  | { readonly operation: 'clear' }

export interface ScriptedSessionPersistence extends SessionPersistence {
  readonly calls: readonly SessionPersistenceCall[]
  enqueue(operation: 'read', result: StoredSessionRead | Promise<StoredSessionRead>): void
  enqueue(operation: 'replace', result: SessionReplacement | Promise<SessionReplacement>): void
  enqueue(operation: 'clear', result: SessionClearance | Promise<SessionClearance>): void
}

type SessionPersistenceOperation = 'read' | 'replace' | 'clear'
type AnySessionOutcome = StoredSessionRead | SessionReplacement | SessionClearance

export function createInMemorySessionPersistence(): ScriptedSessionPersistence {
  const calls: SessionPersistenceCall[] = []
  const scripted = new Map<
    SessionPersistenceOperation,
    (AnySessionOutcome | Promise<AnySessionOutcome>)[]
  >()

  function take(operation: SessionPersistenceOperation): Promise<AnySessionOutcome> {
    const next = scripted.get(operation)?.shift()
    if (next === undefined) {
      throw new Error(`No scripted result for Session persistence operation "${operation}".`)
    }
    return Promise.resolve(next)
  }

  function enqueue(
    operation: SessionPersistenceOperation,
    result: AnySessionOutcome | Promise<AnySessionOutcome>
  ): void {
    const queue = scripted.get(operation)
    if (queue === undefined) scripted.set(operation, [result])
    else queue.push(result)
  }

  return {
    async read() {
      calls.push({ operation: 'read' })
      return (await take('read')) as StoredSessionRead
    },
    async replace(session) {
      calls.push({ operation: 'replace', session })
      return (await take('replace')) as SessionReplacement
    },
    async clear() {
      calls.push({ operation: 'clear' })
      return (await take('clear')) as SessionClearance
    },
    calls,
    enqueue
  } as ScriptedSessionPersistence
}
