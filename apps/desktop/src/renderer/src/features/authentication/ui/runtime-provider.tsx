import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useAuthenticationRuntime,
  type AuthenticationRuntime,
  type AuthenticationRuntimeDependencies
} from '../model/use-authentication-runtime'
import { AuthenticationRuntimeContext } from '../model/runtime-context'
import { RememberedEmailPersistenceNotice } from './remembered-email-persistence-notice'

/**
 * The runtime provider core: it runs the deep Authentication runtime, hands it
 * to the Feature-owned context, and renders the authenticated Authentication
 * notices itself — persistence degradation stays owned here instead of being
 * interpreted by app pages.
 */
export function AuthenticationRuntimeProvider({
  dependencies,
  serverUrl,
  children
}: {
  readonly dependencies: AuthenticationRuntimeDependencies
  readonly serverUrl: string | undefined
  readonly children: ReactNode
}): React.JSX.Element {
  const runtime = useAuthenticationRuntime(dependencies, serverUrl)

  return (
    <AuthenticationRuntimeContext.Provider value={runtime}>
      {children}
      <AuthenticatedAuthenticationNotices runtime={runtime} />
    </AuthenticationRuntimeContext.Provider>
  )
}

function AuthenticatedAuthenticationNotices({
  runtime
}: {
  readonly runtime: AuthenticationRuntime
}): React.JSX.Element {
  const { t } = useTranslation('authentication')
  const authenticated = runtime.status === 'authenticated'

  return (
    <div className="fixed right-6 bottom-6 z-50 flex flex-col items-end gap-2">
      {authenticated && runtime.isSessionPersistenceUnavailable ? (
        <p
          role="status"
          className="bg-card text-muted-foreground max-w-sm rounded-lg border px-4 py-3 text-sm shadow-sm"
        >
          {t('sessionPersistence.unavailable')}
        </p>
      ) : null}
      <RememberedEmailPersistenceNotice
        surface="authenticated"
        isSurfaceActive={authenticated}
        isPersistenceUnavailable={runtime.isRememberedEmailPersistenceUnavailable}
        noticeSurface={runtime.rememberedEmailPersistenceNoticeSurface}
        onShown={runtime.consumeRememberedEmailPersistenceNotice}
      />
    </div>
  )
}
