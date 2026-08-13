import i18next from 'i18next'
import { useCallback, useRef, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { createI18nOptions } from '../../../src/shared/i18n/i18next-options'
import {
  ActiveOrganizationProvider,
  OrganizationOnboardingProvider,
  organizationResources,
  StartupFailureView,
  StartupRestoringView,
  useActiveOrganization
} from '../../../src/renderer/src/features/organization'

const testI18n = i18next.createInstance()
await testI18n.init(
  createI18nOptions({
    language: 'en',
    resources: organizationResources,
    defaultNS: 'organization',
    environment: 'test'
  })
)

function StartupPhaseProbe(): React.JSX.Element {
  const { startupPhase } = useActiveOrganization()

  return <output aria-label="Organization startup phase">{startupPhase}</output>
}

export function FailedStartupPrerequisiteStory(): React.JSX.Element {
  return (
    <OrganizationOnboardingProvider>
      <ActiveOrganizationProvider
        isAuthenticated
        getSession={async () => {
          throw new Error('Injected startup prerequisite failure')
        }}
        hasCompletedProfile={async () => true}
      >
        <StartupPhaseProbe />
      </ActiveOrganizationProvider>
    </OrganizationOnboardingProvider>
  )
}

export function StartupFailureStory(): React.JSX.Element {
  const [retryCount, setRetryCount] = useState(0)

  return (
    <I18nextProvider i18n={testI18n}>
      <StartupFailureView onRetry={() => setRetryCount((count) => count + 1)} />
      <output aria-label="Startup retry count">{retryCount}</output>
    </I18nextProvider>
  )
}

function StartupRecoveryProbe(): React.JSX.Element {
  const { startupPhase, retryStartup } = useActiveOrganization()

  if (startupPhase === 'failed') return <StartupFailureView onRetry={retryStartup} />
  if (startupPhase !== 'ready') return <StartupRestoringView />
  return <output aria-label="Organization startup phase">ready</output>
}

function ActiveOrganizationProbe(): React.JSX.Element {
  const { activeOrganization, startupPhase } = useActiveOrganization()

  return (
    <output aria-label="Active Organization">
      {activeOrganization?.organizationId ?? startupPhase}
    </output>
  )
}

export function StartupRecoveryStory({
  persistent = false,
  failFirst = true
}: {
  readonly persistent?: boolean
  readonly failFirst?: boolean
}): React.JSX.Element {
  const profileAttemptRef = useRef(0)
  const [profileAttemptCount, setProfileAttemptCount] = useState(0)
  const hasCompletedProfile = useCallback(async (): Promise<boolean> => {
    const attempt = ++profileAttemptRef.current
    setProfileAttemptCount(attempt)
    if (persistent || (failFirst && attempt === 1)) {
      throw new Error('Injected startup prerequisite failure')
    }
    return true
  }, [failFirst, persistent])
  const getSession = useCallback(
    async () => ({
      accessToken: 'component-test-access-token',
      userId: 'component-test-user',
      email: 'component@example.com'
    }),
    []
  )

  return (
    <I18nextProvider i18n={testI18n}>
      <div>
        <OrganizationOnboardingProvider>
          <ActiveOrganizationProvider
            isAuthenticated
            getSession={getSession}
            hasCompletedProfile={hasCompletedProfile}
          >
            <StartupRecoveryProbe />
          </ActiveOrganizationProvider>
        </OrganizationOnboardingProvider>
        <output aria-label="Profile prerequisite attempts">{profileAttemptCount}</output>
      </div>
    </I18nextProvider>
  )
}

export function StaleStartupResultStory(): React.JSX.Element {
  const [providerSession, setProviderSession] = useState<'old' | 'new' | 'unmounted'>('old')
  const [oldProfile] = useState(() => {
    let resolve!: (completed: boolean) => void
    const promise = new Promise<boolean>((complete) => {
      resolve = complete
    })
    return { promise, resolve }
  })
  const [oldProfileReleased, setOldProfileReleased] = useState(false)

  function releaseOldProfile(): void {
    oldProfile.resolve(true)
    setOldProfileReleased(true)
  }

  const provider =
    providerSession === 'unmounted' ? (
      <output aria-label="Provider state">unmounted</output>
    ) : (
      <OrganizationOnboardingProvider>
        <ActiveOrganizationProvider
          key={providerSession}
          isAuthenticated
          getSession={async () => ({
            accessToken: `${providerSession}-session-token`,
            userId: `${providerSession}-user`,
            email: `${providerSession}@example.com`
          })}
          hasCompletedProfile={async (session) =>
            session.userId === 'old-user' ? oldProfile.promise : true
          }
        >
          <ActiveOrganizationProbe />
        </ActiveOrganizationProvider>
      </OrganizationOnboardingProvider>
    )

  return (
    <div>
      {provider}
      <button type="button" onClick={() => setProviderSession('unmounted')}>
        Unmount provider
      </button>
      <button type="button" onClick={() => setProviderSession('new')}>
        Switch Session
      </button>
      <button type="button" onClick={releaseOldProfile}>
        Release old Profile
      </button>
      <output aria-label="Old Profile state">{oldProfileReleased ? 'released' : 'pending'}</output>
    </div>
  )
}
