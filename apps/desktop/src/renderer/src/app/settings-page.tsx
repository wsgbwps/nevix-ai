import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeftIcon, LanguagesIcon } from 'lucide-react'
import { LanguageModeSettings } from '../features/language'
import { useAuthenticationState } from './authentication-state'

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
        <nav aria-label={t('settings.title')} className="grid gap-1">
          {/* The Language Mode item is the only real setting today; it stays selected until
            another Feature contributes its own settings section. */}
          <span
            aria-current="page"
            className="bg-sidebar-accent text-sidebar-accent-foreground flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium"
          >
            <LanguagesIcon className="size-4" />
            {t('settings.language')}
          </span>
        </nav>
      </aside>
      <main className="max-h-svh flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-8 py-10">
          <h1 className="text-2xl font-semibold tracking-tight">{t('settings.title')}</h1>
          <section aria-labelledby="settings-language-heading" className="grid gap-3">
            <h2 id="settings-language-heading" className="text-base font-semibold">
              {t('settings.language')}
            </h2>
            <div className="bg-card rounded-lg border">
              <LanguageModeSettings />
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
