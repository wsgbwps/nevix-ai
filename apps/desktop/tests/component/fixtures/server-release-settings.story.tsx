import i18next from 'i18next'
import { useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { createI18nOptions } from '../../../src/shared/i18n/i18next-options'
import { ServerReleaseSettings, releaseResources } from '../../../src/renderer/src/features/release'

const instances = { en: i18next.createInstance(), 'zh-CN': i18next.createInstance() }
for (const language of ['en', 'zh-CN'] as const) {
  await instances[language].init(
    createI18nOptions({
      language,
      resources: releaseResources,
      defaultNS: 'release',
      environment: 'test'
    })
  )
}
const getSession = async (): Promise<{ token: string }> => ({ token: 'admin-session' })
export function ServerReleaseSettingsStory({
  language = 'en'
}: {
  language?: 'en' | 'zh-CN'
}): React.JSX.Element {
  return (
    <I18nextProvider i18n={instances[language]}>
      <ServerReleaseSettings getSession={getSession} serverUrl="https://server.test" />
    </I18nextProvider>
  )
}

export function ServerReleaseConnectionSwitchStory(): React.JSX.Element {
  const [serverUrl, setServerUrl] = useState('https://server.test')
  return (
    <I18nextProvider i18n={instances.en}>
      <button type="button" onClick={() => setServerUrl('https://other.test')}>
        Switch server
      </button>
      <ServerReleaseSettings getSession={getSession} serverUrl={serverUrl} />
    </I18nextProvider>
  )
}
