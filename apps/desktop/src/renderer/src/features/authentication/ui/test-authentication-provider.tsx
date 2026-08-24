import { useState, type ReactNode } from 'react'
import type { GoAuthentication } from '../api/go-authentication'
import type { RememberedEmailPersistence } from '../api/remembered-email-persistence'
import type { AuthenticationRuntimeDependencies } from '../model/use-authentication-runtime'
import type { SessionPersistence } from '../session/session-persistence'
import { AuthenticationRuntimeProvider } from './runtime-provider'

/**
 * Authentication-owned test composition (#132 testing decisions): the same
 * production runtime core, but the in-memory Go Authentication, Session
 * persistence, and Remembered Email persistence adapters supply the seams.
 * Tests still drive and assert through the public module interface — the
 * owned surface and the current-session reader. Never exported through the
 * Feature public interface.
 */
export function TestAuthenticationProvider({
  serverUrl,
  goAuthentication,
  sessionPersistence,
  rememberedEmailPersistence,
  children
}: {
  readonly serverUrl: string | undefined
  readonly goAuthentication: GoAuthentication
  readonly sessionPersistence: SessionPersistence
  readonly rememberedEmailPersistence: RememberedEmailPersistence
  readonly children: ReactNode
}): React.JSX.Element {
  // The scripted adapters are captured for the whole document; a test never
  // swaps the seams mid-run.
  const [dependencies] = useState<AuthenticationRuntimeDependencies>(() => ({
    connectGoAuthentication: () => goAuthentication,
    sessionPersistence,
    rememberedEmailPersistence
  }))

  return (
    <AuthenticationRuntimeProvider dependencies={dependencies} serverUrl={serverUrl}>
      {children}
    </AuthenticationRuntimeProvider>
  )
}
