/**
 * The in-memory Go Authentication adapter for Authentication-owned test
 * composition. Tests script semantic verdicts, deferred completions (a pending
 * promise stays pending until the test settles it), and completion order
 * (queue several results and settle them in any order); every call is
 * recorded so tests can assert single-flight and generation behavior. An
 * unscripted call rejects loudly — a test must never exercise real transport.
 */
import type {
  GoAuthentication,
  InstanceClaimResult,
  PasswordChangeResult,
  RegistrationResult,
  SessionEndResult,
  SessionValidationResult,
  SetupProbeResult,
  SignInResult
} from './go-authentication'

export type GoAuthenticationCall =
  | { readonly operation: 'probeSetup' }
  | {
      readonly operation: 'claimInstance'
      readonly email: string
      readonly password: string
      readonly setupCode: string | undefined
      readonly displayName: string | undefined
    }
  | { readonly operation: 'signIn'; readonly email: string; readonly password: string }
  | {
      readonly operation: 'register'
      readonly email: string
      readonly password: string
      readonly joinCode: string
      readonly displayName: string | undefined
    }
  | { readonly operation: 'validateSession'; readonly token: string }
  | {
      readonly operation: 'changePassword'
      readonly token: string
      readonly currentPassword: string
      readonly newPassword: string
    }
  | { readonly operation: 'endSession'; readonly token: string }

export interface ScriptedGoAuthentication extends GoAuthentication {
  readonly calls: readonly GoAuthenticationCall[]
  enqueue(operation: 'probeSetup', result: SetupProbeResult | Promise<SetupProbeResult>): void
  enqueue(
    operation: 'claimInstance',
    result: InstanceClaimResult | Promise<InstanceClaimResult>
  ): void
  enqueue(operation: 'signIn', result: SignInResult | Promise<SignInResult>): void
  enqueue(operation: 'register', result: RegistrationResult | Promise<RegistrationResult>): void
  enqueue(
    operation: 'validateSession',
    result: SessionValidationResult | Promise<SessionValidationResult>
  ): void
  enqueue(
    operation: 'changePassword',
    result: PasswordChangeResult | Promise<PasswordChangeResult>
  ): void
  enqueue(operation: 'endSession', result: SessionEndResult | Promise<SessionEndResult>): void
}

type GoAuthenticationOperation =
  | 'probeSetup'
  | 'claimInstance'
  | 'signIn'
  | 'register'
  | 'validateSession'
  | 'changePassword'
  | 'endSession'

type AnyResult =
  | SetupProbeResult
  | InstanceClaimResult
  | SignInResult
  | RegistrationResult
  | SessionValidationResult
  | PasswordChangeResult
  | SessionEndResult

export function createInMemoryGoAuthentication(): ScriptedGoAuthentication {
  const calls: GoAuthenticationCall[] = []
  const scripted = new Map<GoAuthenticationOperation, (AnyResult | Promise<AnyResult>)[]>()

  function take(operation: GoAuthenticationOperation): Promise<AnyResult> {
    const queue = scripted.get(operation)
    const next = queue?.shift()
    if (next === undefined) {
      throw new Error(`No scripted result for Go Authentication operation "${operation}".`)
    }
    return Promise.resolve(next)
  }

  function enqueue(
    operation: GoAuthenticationOperation,
    result: AnyResult | Promise<AnyResult>
  ): void {
    const queue = scripted.get(operation)
    if (queue === undefined) scripted.set(operation, [result])
    else queue.push(result)
  }

  return {
    async probeSetup() {
      calls.push({ operation: 'probeSetup' })
      return (await take('probeSetup')) as SetupProbeResult
    },
    async claimInstance(email, password, setupCode, displayName) {
      calls.push({ operation: 'claimInstance', email, password, setupCode, displayName })
      return (await take('claimInstance')) as InstanceClaimResult
    },
    async signIn(email, password) {
      calls.push({ operation: 'signIn', email, password })
      return (await take('signIn')) as SignInResult
    },
    async register(email, password, joinCode, displayName) {
      calls.push({ operation: 'register', email, password, joinCode, displayName })
      return (await take('register')) as RegistrationResult
    },
    async validateSession(token) {
      calls.push({ operation: 'validateSession', token })
      return (await take('validateSession')) as SessionValidationResult
    },
    async changePassword(token, currentPassword, newPassword) {
      calls.push({ operation: 'changePassword', token, currentPassword, newPassword })
      return (await take('changePassword')) as PasswordChangeResult
    },
    async endSession(token) {
      calls.push({ operation: 'endSession', token })
      return (await take('endSession')) as SessionEndResult
    },
    calls,
    enqueue
  } as ScriptedGoAuthentication
}
