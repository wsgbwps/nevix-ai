import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { useState } from 'react'
import { createI18nOptions } from '../../../src/shared/i18n/i18next-options'
import {
  authenticationResources,
  AuthenticationSurface,
  useCurrentSession
} from '../../../src/renderer/src/features/authentication'
import { TestAuthenticationProvider } from '../../../src/renderer/src/features/authentication/ui/test-authentication-provider'
import { createInMemoryGoAuthentication } from '../../../src/renderer/src/features/authentication/api/in-memory-go-authentication'
import { createInMemoryRememberedEmailPersistence } from '../../../src/renderer/src/features/authentication/api/in-memory-remembered-email'
import { createInMemorySessionPersistence } from '../../../src/renderer/src/features/authentication/session/in-memory-session-persistence'
import { ThemeProvider } from '../../../src/renderer/src/components/theme-provider'

/**
 * Black-box module-test composition for the Authentication runtime (#132
 * testing decisions): the public owned surface and the public current-session
 * reader, mounted on the Authentication-owned test provider with in-memory
 * adapters. Tests drive visible user behavior in the real DOM and observe the
 * rendered output plus the external current-session result.
 */

const testI18n = i18next.createInstance()
await testI18n.init(
  createI18nOptions({
    language: 'en',
    resources: authenticationResources,
    defaultNS: 'authentication',
    environment: 'test'
  })
)

/** A preset result that stays pending until the test settles it by index. */
export interface DeferredResult {
  readonly __defer: true
}

export interface AuthenticationRuntimePreset {
  readonly sessionRead?: unknown
  readonly rememberedRead?: unknown
  readonly probeSetup?: unknown
  readonly validateSession?: unknown
}

/** The minimal scripted-adapter surface the preset consumer needs. */
interface PresetQueueable {
  enqueue(operation: string, result: unknown | Promise<unknown>): void
}

interface AuthenticationModuleTestControls {
  readonly go: PresetQueueable & ReturnType<typeof createInMemoryGoAuthentication>
  readonly sessions: PresetQueueable & ReturnType<typeof createInMemorySessionPersistence>
  readonly remembered: PresetQueueable & ReturnType<typeof createInMemoryRememberedEmailPersistence>
  readonly calls: {
    readonly go: readonly unknown[]
    readonly sessions: readonly unknown[]
    readonly remembered: readonly unknown[]
  }
  makeDeferred(): { readonly index: number; readonly promise: Promise<unknown> }
  settle(index: number, value: unknown): void
}

declare global {
  interface Window {
    __authRuntimePreset?: AuthenticationRuntimePreset
    __authRuntimeTest?: AuthenticationModuleTestControls
  }
}

/**
 * Created once per page: adapter creation, preset consumption, and the window
 * control surface are idempotent under React's double-invoked dev renders.
 */
let controls: AuthenticationModuleTestControls | undefined

function getControls(): AuthenticationModuleTestControls {
  if (controls !== undefined) return controls

  const go = createInMemoryGoAuthentication()
  const sessions = createInMemorySessionPersistence()
  const remembered = createInMemoryRememberedEmailPersistence()
  const deferredResolvers: Array<(value: unknown) => void> = []
  const next: AuthenticationModuleTestControls = {
    go,
    sessions,
    remembered,
    calls: {
      get go(): readonly unknown[] {
        return go.calls
      },
      get sessions(): readonly unknown[] {
        return sessions.calls
      },
      get remembered(): readonly unknown[] {
        return remembered.calls
      }
    },
    makeDeferred() {
      const index = deferredResolvers.length
      const promise = new Promise<unknown>((resolve) => {
        deferredResolvers[index] = resolve
      })
      return { index, promise }
    },
    settle(index: number, value: unknown): void {
      deferredResolvers[index]?.(value)
    }
  }

  const preset = window.__authRuntimePreset ?? {}
  function enqueuePreset(adapter: PresetQueueable, operation: string, value: unknown): void {
    if (value === undefined) return
    adapter.enqueue(
      operation,
      (value as DeferredResult)?.__defer === true ? next.makeDeferred().promise : value
    )
  }
  enqueuePreset(sessions, 'read', preset.sessionRead)
  enqueuePreset(remembered, 'read', preset.rememberedRead)
  enqueuePreset(go, 'probeSetup', preset.probeSetup)
  enqueuePreset(go, 'validateSession', preset.validateSession)

  window.__authRuntimeTest = next
  controls = next
  return next
}

/** Observes the external current-session result; tests assert on this output. */
function CurrentSessionObserver(): React.JSX.Element {
  const session = useCurrentSession()
  const [acquisitionResult, setAcquisitionResult] = useState('not-acquired')
  const [capturedAcquire, setCapturedAcquire] = useState<
    (() => Promise<{ readonly token: string } | undefined>) | undefined
  >(undefined)

  async function acquire(): Promise<void> {
    const acquireSession =
      capturedAcquire ?? (session.status === 'available' ? session.acquireSession : undefined)
    const acquisition = acquireSession === undefined ? undefined : await acquireSession()
    setAcquisitionResult(acquisition === undefined ? 'unavailable' : acquisition.token)
  }

  return (
    <div data-testid="current-session">
      <output data-testid="session-status">{session.status}</output>
      <button type="button" data-testid="acquire-session" onClick={() => void acquire()}>
        acquire session
      </button>
      <output data-testid="acquisition-result">{acquisitionResult}</output>
      {session.status === 'available' ? (
        <>
          <output data-testid="session-user-id">{session.user.id}</output>
          <output data-testid="session-email">{session.user.email}</output>
          <output data-testid="session-role">{session.user.role}</output>
          <output data-testid="session-signing-out">{String(session.isSigningOut)}</output>
          {/* A peer-style caller can hold the acquisition capability it once
              received; invoking it later must answer from the live runtime. */}
          <button
            type="button"
            data-testid="capture-capability"
            onClick={() => setCapturedAcquire(() => session.acquireSession)}
          >
            capture capability
          </button>
          <button type="button" data-testid="sign-out" onClick={() => void session.signOut()}>
            sign out
          </button>
        </>
      ) : null}
    </div>
  )
}

export function AuthenticationRuntimeStory({
  dormant = false
}: {
  /** Mounts the runtime without a server URL: it must stay dormant. */
  readonly dormant?: boolean
}): React.JSX.Element {
  const testControls = getControls()

  return (
    <ThemeProvider defaultTheme="dark" storageKey="nevix-module-test-theme">
      <I18nextProvider i18n={testI18n}>
        <TestAuthenticationProvider
          serverUrl={dormant ? undefined : 'https://module-test-server.example'}
          goAuthentication={testControls.go}
          sessionPersistence={testControls.sessions}
          rememberedEmailPersistence={testControls.remembered}
        >
          <AuthenticationSurface />
          <CurrentSessionObserver />
        </TestAuthenticationProvider>
      </I18nextProvider>
    </ThemeProvider>
  )
}
