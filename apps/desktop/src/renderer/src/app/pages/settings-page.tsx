import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeftIcon, LanguagesIcon, UserRoundIcon } from 'lucide-react'
import { LanguageModeSettings } from '../../features/language'
import { AuditLogSettings, AuditLogSettingsNavigation } from '../../features/organization'
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
      <aside className="bg-sidebar text-sidebar-foreground flex w-64 shrink-0 flex-col gap-6 border-r p-4">
        <Link
          to="/"
          className="text-muted-foreground hover:text-foreground flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors"
        >
          <ArrowLeftIcon className="size-4" />
          {t('settings.back')}
        </Link>
        <nav aria-label={t('settings.title')} className="grid gap-4">
          <div className="grid gap-1">
            <p className="text-muted-foreground px-2.5 text-xs font-medium tracking-wide uppercase">
              {t('settings.account')}
            </p>
            <a
              href="#profile"
              className="text-sidebar-foreground hover:bg-sidebar-accent flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium"
            >
              <UserRoundIcon className="size-4" />
              {t('settings.profile')}
            </a>
            <a
              href="#language"
              className="text-sidebar-foreground hover:bg-sidebar-accent flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium"
            >
              <LanguagesIcon className="size-4" />
              {t('settings.language')}
            </a>
          </div>
          <AuditLogSettingsNavigation />
        </nav>
      </aside>
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
          <AuditLogSettings getSession={authentication.getSession} />
        </div>
      </main>
    </div>
  )
}
