import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import type { AuthenticationError } from '../hooks/use-authentication'

interface AuthenticationScreenProps {
  readonly status: 'configuration-error' | 'restoring' | 'unauthenticated'
  readonly error?: AuthenticationError
  readonly isSubmitting?: boolean
  readonly onSignIn?: (email: string, password: string) => Promise<void>
  readonly secondaryContent?: React.ReactNode
}

export function AuthenticationScreen({
  status,
  error,
  isSubmitting = false,
  onSignIn,
  secondaryContent
}: AuthenticationScreenProps): React.JSX.Element {
  const { t } = useTranslation('authentication')

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!onSignIn || isSubmitting) return

    const formData = new FormData(event.currentTarget)
    const email = formData.get('email')
    const password = formData.get('password')
    if (typeof email !== 'string' || typeof password !== 'string') return

    void onSignIn(email, password)
  }

  if (status !== 'unauthenticated') {
    const translationKey = status === 'restoring' ? 'restoring' : 'configurationError'

    return (
      <main className="bg-background flex h-screen items-center justify-center px-6">
        <section className="bg-card w-full max-w-md rounded-2xl border p-8 text-center shadow-sm">
          <h1 className="text-2xl font-semibold">{t(`${translationKey}.heading`)}</h1>
          <p className="text-muted-foreground mt-3 text-sm">{t(`${translationKey}.description`)}</p>
        </section>
      </main>
    )
  }

  return (
    <main className="bg-muted/30 grid h-screen lg:grid-cols-[minmax(18rem,0.8fr)_minmax(28rem,1.2fr)]">
      <aside className="from-primary/10 to-background hidden border-r bg-linear-to-br p-10 lg:flex lg:flex-col lg:justify-between">
        <div className="border-primary text-primary grid size-11 place-items-center rounded-xl border-2 text-lg font-bold">
          N
        </div>
        <p className="text-muted-foreground max-w-xs text-sm leading-6">Nevix AI</p>
      </aside>
      <section className="flex items-center justify-center p-6">
        <form
          className="bg-card w-full max-w-sm rounded-2xl border p-7 shadow-sm"
          onSubmit={submit}
        >
          <header className="mb-7 text-center">
            <h1 className="text-2xl font-bold">{t('login.heading')}</h1>
            <p className="text-muted-foreground mt-2 text-sm">{t('login.description')}</p>
          </header>
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-3">
              <label htmlFor="authentication-email" className="text-sm leading-none font-medium">
                {t('login.email')}
              </label>
              <input
                id="authentication-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                disabled={isSubmitting}
                className="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/30 h-10 w-full rounded-xl border px-3 text-sm outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
            <div className="flex flex-col gap-3">
              <label htmlFor="authentication-password" className="text-sm leading-none font-medium">
                {t('login.password')}
              </label>
              <input
                id="authentication-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                disabled={isSubmitting}
                className="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/30 h-10 w-full rounded-xl border px-3 text-sm outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {t(
                  error === 'invalid-credentials'
                    ? 'login.invalidCredentials'
                    : 'login.serviceError'
                )}
              </p>
            ) : null}
            <div className="flex flex-col gap-3">
              <Button type="submit" disabled={isSubmitting}>
                {t(isSubmitting ? 'login.submitting' : 'login.submit')}
              </Button>
            </div>
          </div>
          {secondaryContent ? <div className="mt-7">{secondaryContent}</div> : null}
        </form>
      </section>
    </main>
  )
}
