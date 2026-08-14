import i18next from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { createI18nOptions } from '../../../src/shared/i18n/i18next-options'
import {
  authenticationResources,
  RememberedEmailPersistenceNotice,
  useAuthentication
} from '../../../src/renderer/src/features/authentication'

const testI18n = i18next.createInstance()
await testI18n.init(
  createI18nOptions({
    language: 'en',
    resources: authenticationResources,
    defaultNS: 'authentication',
    environment: 'test'
  })
)

type AuthenticationTransitionTestWindow = Window & {
  releaseRememberedEmailClearFailure: () => void
  releaseRememberedEmailReplacementFailure: () => void
}

export function AuthenticationTransitionStory(): React.JSX.Element {
  const authentication = useAuthentication()

  async function enterAuthenticatedShellBeforeClearFails(): Promise<void> {
    authentication.setRememberEmailSelected(false)
    await authentication.signIn('remembered-transition@example.com', 'correct horse battery staple')
    const testWindow = window as unknown as AuthenticationTransitionTestWindow
    testWindow.releaseRememberedEmailClearFailure()
  }

  async function leaveAuthenticatedShellBeforeReplacementFails(): Promise<void> {
    await authentication.signIn('remembered-transition@example.com', 'correct horse battery staple')
    await authentication.signOut()
    const testWindow = window as unknown as AuthenticationTransitionTestWindow
    testWindow.releaseRememberedEmailReplacementFailure()
  }

  return (
    <I18nextProvider i18n={testI18n}>
      <button
        type="button"
        disabled={authentication.status !== 'unauthenticated'}
        onClick={() => void enterAuthenticatedShellBeforeClearFails()}
      >
        Enter authenticated shell before clear fails
      </button>
      <button
        type="button"
        disabled={authentication.status !== 'unauthenticated'}
        onClick={() => void leaveAuthenticatedShellBeforeReplacementFails()}
      >
        Leave authenticated shell before replacement fails
      </button>
      <output aria-label="Authentication status">{authentication.status}</output>
      <RememberedEmailPersistenceNotice
        surface="login"
        isSurfaceActive={authentication.status === 'unauthenticated'}
        isPersistenceUnavailable={authentication.isRememberedEmailPersistenceUnavailable}
        noticeSurface={authentication.rememberedEmailPersistenceNoticeSurface}
        onShown={authentication.consumeRememberedEmailPersistenceNotice}
      />
      <RememberedEmailPersistenceNotice
        surface="authenticated"
        isSurfaceActive={authentication.status === 'authenticated'}
        isPersistenceUnavailable={authentication.isRememberedEmailPersistenceUnavailable}
        noticeSurface={authentication.rememberedEmailPersistenceNoticeSurface}
        onShown={authentication.consumeRememberedEmailPersistenceNotice}
      />
    </I18nextProvider>
  )
}
