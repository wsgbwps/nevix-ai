import { useTranslation } from 'react-i18next'
import { LanguageModeSettings } from '../../features/language'
import {
  AuditLogSettings,
  MembersSettings,
  OrganizationSettingsSidebar
} from '../../features/organization'
import { ProfileSettings } from '../../features/profile'
import { useAuthenticationState } from '../authentication-state'

export function SettingsPage(): React.JSX.Element | null {
  const { t } = useTranslation('app')
  const authentication = useAuthenticationState()

  if (authentication.status !== 'authenticated') {
    // The root route is already navigating to the authentication view; render nothing on the
    // transient frame so the Settings Page never shows for a signed-out user.
    return null
  }

  return (
    <div className="flex min-h-svh w-full">
      <OrganizationSettingsSidebar
        backLabel={t('settings.back')}
        navigationLabel={t('settings.title')}
        profileLabel={t('settings.profile')}
        languageLabel={t('settings.language')}
      />
      <main className="max-h-svh flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-8 py-10">
          <h1 className="text-2xl font-semibold tracking-tight">{t('settings.title')}</h1>
          <div id="profile" className="bg-card rounded-lg border">
            <ProfileSettings getSession={authentication.getSession} />
          </div>
          <section id="language" aria-labelledby="settings-language-heading" className="grid gap-3">
            <h2 id="settings-language-heading" className="text-base font-semibold">
              {t('settings.language')}
            </h2>
            <div className="bg-card rounded-lg border">
              <LanguageModeSettings />
            </div>
          </section>
          <MembersSettings getSession={authentication.getSession} />
          <AuditLogSettings getSession={authentication.getSession} />
        </div>
      </main>
    </div>
  )
}
