import { useState, type ReactNode } from 'react'
import { createGoAuthenticationOverHttp } from '../api/go-authentication-http'
import { createRememberedEmailPersistenceOverIpc } from '../api/remembered-email'
import { createSessionPersistenceOverIpc } from '../session/persisted-session'
import type { AuthenticationRuntimeDependencies } from '../model/use-authentication-runtime'
import { AuthenticationRuntimeProvider } from './runtime-provider'

/**
 * The production Authentication runtime provider: one per renderer document.
 * It starts dormant without a server URL — no Authentication or persistence
 * I/O — and binds permanently to the first configured URL; a server change
 * clears the session and reloads the renderer instead of hot-swapping.
 */
export function AuthenticationProvider({
  serverUrl,
  children
}: {
  readonly serverUrl: string | undefined
  readonly children: ReactNode
}): React.JSX.Element {
  // The production adapter composition is fixed once per renderer document:
  // the Go Authentication HTTP port over the identity API plus the encrypted
  // Session and Remembered Email IPC stores. Creation performs no I/O.
  const [dependencies] = useState<AuthenticationRuntimeDependencies>(() => ({
    connectGoAuthentication: createGoAuthenticationOverHttp,
    sessionPersistence: createSessionPersistenceOverIpc(),
    rememberedEmailPersistence: createRememberedEmailPersistenceOverIpc()
  }))

  return (
    <AuthenticationRuntimeProvider dependencies={dependencies} serverUrl={serverUrl}>
      {children}
    </AuthenticationRuntimeProvider>
  )
}
