import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeftIcon } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Separator } from '../components/ui/separator'
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
      <div className="bg-muted/40 flex min-h-svh w-full flex-col">
        <div className="flex flex-col gap-4 py-4 md:py-8 md:pl-8">
          <div className="mx-auto flex w-full max-w-6xl items-center gap-4 md:ml-4">
            <header className="flex items-center gap-4">
              <Button variant="outline" size="icon" aria-label={t('settings.back')} asChild>
                <Link to="/">
                  <ArrowLeftIcon />
                </Link>
              </Button>
              <Separator orientation="vertical" className="h-4" />
              <h1 className="text-lg font-semibold">{t('settings.title')}</h1>
            </header>
          </div>
          <div className="mx-auto grid w-full max-w-6xl items-start gap-4 md:grid-cols-[180px_1fr] lg:grid-cols-[250px_1fr]">
            <nav
              aria-label={t('settings.title')}
              className="text-muted-foreground grid gap-4 text-sm"
            >
              {/* The Language Mode item is the only real setting today; it stays selected until
                another Feature contributes its own settings section. */}
              <span className="text-primary font-semibold">{t('settings.language')}</span>
            </nav>
            <div className="grid gap-4">
              <LanguageModeSettings />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
