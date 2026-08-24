/**
 * The in-memory Remembered Email persistence adapter for Authentication-owned
 * test composition. Tests script outcomes, deferred completions, and
 * completion order; every call is recorded so tests can assert mutation
 * serialization and selection-order semantics. An unscripted call rejects
 * loudly — a test must never touch real storage.
 */
import type {
  RememberedEmailClearance,
  RememberedEmailPersistence,
  RememberedEmailRead,
  RememberedEmailReplacement
} from './remembered-email-persistence'

export type RememberedEmailPersistenceCall =
  | { readonly operation: 'read' }
  | { readonly operation: 'replace'; readonly email: string }
  | { readonly operation: 'clear' }

export interface ScriptedRememberedEmailPersistence extends RememberedEmailPersistence {
  readonly calls: readonly RememberedEmailPersistenceCall[]
  enqueue(operation: 'read', result: RememberedEmailRead | Promise<RememberedEmailRead>): void
  enqueue(
    operation: 'replace',
    result: RememberedEmailReplacement | Promise<RememberedEmailReplacement>
  ): void
  enqueue(
    operation: 'clear',
    result: RememberedEmailClearance | Promise<RememberedEmailClearance>
  ): void
}

type RememberedEmailOperation = 'read' | 'replace' | 'clear'
type AnyRememberedEmailOutcome =
  | RememberedEmailRead
  | RememberedEmailReplacement
  | RememberedEmailClearance

export function createInMemoryRememberedEmailPersistence(): ScriptedRememberedEmailPersistence {
  const calls: RememberedEmailPersistenceCall[] = []
  const scripted = new Map<
    RememberedEmailOperation,
    (AnyRememberedEmailOutcome | Promise<AnyRememberedEmailOutcome>)[]
  >()

  function take(operation: RememberedEmailOperation): Promise<AnyRememberedEmailOutcome> {
    const next = scripted.get(operation)?.shift()
    if (next === undefined) {
      throw new Error(`No scripted result for Remembered Email operation "${operation}".`)
    }
    return Promise.resolve(next)
  }

  function enqueue(
    operation: RememberedEmailOperation,
    result: AnyRememberedEmailOutcome | Promise<AnyRememberedEmailOutcome>
  ): void {
    const queue = scripted.get(operation)
    if (queue === undefined) scripted.set(operation, [result])
    else queue.push(result)
  }

  return {
    async read() {
      calls.push({ operation: 'read' })
      return (await take('read')) as RememberedEmailRead
    },
    async replace(email) {
      calls.push({ operation: 'replace', email })
      return (await take('replace')) as RememberedEmailReplacement
    },
    async clear() {
      calls.push({ operation: 'clear' })
      return (await take('clear')) as RememberedEmailClearance
    },
    calls,
    enqueue
  } as ScriptedRememberedEmailPersistence
}
