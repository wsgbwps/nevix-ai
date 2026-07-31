import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import type {
  AuthenticationError,
  AuthenticationFlow,
  AuthenticationNotice
} from '../model/use-authentication'
import { isPasswordByteLengthValid, passwordByteLength } from '../policy/password'

interface AuthenticationScreenProps {
  readonly status: 'configuration-error' | 'restoring' | 'restore-failure' | 'unauthenticated'
  readonly flow: AuthenticationFlow
  readonly error?: AuthenticationError
  readonly notice?: AuthenticationNotice
  readonly isSubmitting?: boolean
  readonly onRetryRestore: () => Promise<void>
  readonly resendSecondsRemaining: number
  readonly resendGeneration: number
  readonly didResend: boolean
  readonly onShowLogin: () => void
  readonly onShowSignUp: () => void
  readonly onShowRecovery: () => void
  readonly onSignIn: (email: string, password: string) => Promise<void>
  readonly onSignUp: (email: string, password: string) => Promise<void>
  readonly onVerifySignUp: (code: string) => Promise<void>
  readonly onResendSignUp: () => Promise<void>
  readonly onRequestRecovery: (email: string) => Promise<void>
  readonly onVerifyRecovery: (code: string) => Promise<void>
  readonly onCompleteRecovery: (newPassword: string) => Promise<void>
}

export function AuthenticationScreen({
  status,
  flow,
  error,
  notice,
  isSubmitting = false,
  resendSecondsRemaining,
  resendGeneration,
  didResend,
  onRetryRestore,
  onShowLogin,
  onShowSignUp,
  onShowRecovery,
  onSignIn,
  onSignUp,
  onVerifySignUp,
  onResendSignUp,
  onRequestRecovery,
  onVerifyRecovery,
  onCompleteRecovery
}: AuthenticationScreenProps): React.JSX.Element {
  const { t } = useTranslation('authentication')

  if (status !== 'unauthenticated') {
    const translationKey =
      status === 'restoring'
        ? 'restoring'
        : status === 'restore-failure'
          ? 'restoreFailure'
          : 'configurationError'

    return (
      <main className="bg-background flex h-screen items-center justify-center px-6">
        <section className="bg-card w-full max-w-md rounded-2xl border p-8 text-center shadow-sm">
          <h1 className="text-2xl font-semibold">{t(`${translationKey}.heading`)}</h1>
          <p className="text-muted-foreground mt-3 text-sm">{t(`${translationKey}.description`)}</p>
          {status === 'restore-failure' ? (
            <Button className="mt-6" onClick={() => void onRetryRestore()}>
              {t('restoreFailure.retry')}
            </Button>
          ) : null}
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
      <section className="flex items-center justify-center overflow-y-auto p-6">
        <div className="bg-card w-full max-w-sm rounded-2xl border p-7 shadow-sm">
          {flow === 'login' ? (
            <LoginForm
              error={error}
              notice={notice}
              isSubmitting={isSubmitting}
              onSignIn={onSignIn}
              onShowSignUp={onShowSignUp}
              onShowRecovery={onShowRecovery}
            />
          ) : flow === 'signup' ? (
            <SignupForm
              error={error}
              isSubmitting={isSubmitting}
              onSignUp={onSignUp}
              onShowLogin={onShowLogin}
            />
          ) : flow === 'signup-verification' ? (
            <SignupVerificationForm
              key={resendGeneration}
              error={error}
              isSubmitting={isSubmitting}
              resendSecondsRemaining={resendSecondsRemaining}
              didResend={didResend}
              onVerify={onVerifySignUp}
              onResend={onResendSignUp}
              onShowLogin={onShowLogin}
              onShowRecovery={onShowRecovery}
            />
          ) : flow === 'recovery-request' ? (
            <RecoveryRequestForm
              error={error}
              isSubmitting={isSubmitting}
              onRequestRecovery={onRequestRecovery}
              onShowLogin={onShowLogin}
            />
          ) : flow === 'recovery-verification' ? (
            <RecoveryVerificationForm
              error={error}
              isSubmitting={isSubmitting}
              onVerify={onVerifyRecovery}
              onShowLogin={onShowLogin}
            />
          ) : (
            <RecoveryNewPasswordForm
              error={error}
              isSubmitting={isSubmitting}
              onCompleteRecovery={onCompleteRecovery}
              onShowLogin={onShowLogin}
            />
          )}
        </div>
      </section>
    </main>
  )
}

const LOGIN_NOTICE_KEYS = {
  'session-expired': 'login.sessionExpired',
  'remote-sign-out-delayed': 'login.remoteSignOutDelayed',
  'password-updated': 'login.passwordUpdated',
  'password-updated-revocation-delayed': 'login.passwordUpdatedRevocationDelayed'
} as const

function LoginForm({
  error,
  notice,
  isSubmitting,
  onSignIn,
  onShowSignUp,
  onShowRecovery
}: {
  readonly error?: AuthenticationError
  readonly notice?: AuthenticationNotice
  readonly isSubmitting: boolean
  readonly onSignIn: (email: string, password: string) => Promise<void>
  readonly onShowSignUp: () => void
  readonly onShowRecovery: () => void
}): React.JSX.Element {
  const { t } = useTranslation('authentication')

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (isSubmitting) return

    const credentials = readCredentials(event.currentTarget)
    if (credentials) void onSignIn(credentials.email, credentials.password)
  }

  return (
    <form onSubmit={submit}>
      <FormHeader heading={t('login.heading')} description={t('login.description')} />
      <div className="flex flex-col gap-6">
        {notice ? (
          <p role="status" className="text-muted-foreground text-sm">
            {t(LOGIN_NOTICE_KEYS[notice])}
          </p>
        ) : null}
        <CredentialFields passwordAutoComplete="current-password" disabled={isSubmitting} />
        {error ? <AuthenticationErrorMessage error={error} context="login" /> : null}
        <Button type="submit" disabled={isSubmitting}>
          {t(isSubmitting ? 'login.submitting' : 'login.submit')}
        </Button>
        <div className="flex justify-center text-sm">
          <button
            type="button"
            className="text-foreground font-medium underline underline-offset-4"
            disabled={isSubmitting}
            onClick={onShowRecovery}
          >
            {t('login.forgotPassword')}
          </button>
        </div>
        <p className="text-muted-foreground text-center text-sm">
          {t('login.noAccount')}{' '}
          <button
            type="button"
            className="text-foreground font-medium underline underline-offset-4"
            disabled={isSubmitting}
            onClick={onShowSignUp}
          >
            {t('login.createAccount')}
          </button>
        </p>
      </div>
    </form>
  )
}

function SignupForm({
  error,
  isSubmitting,
  onSignUp,
  onShowLogin
}: {
  readonly error?: AuthenticationError
  readonly isSubmitting: boolean
  readonly onSignUp: (email: string, password: string) => Promise<void>
  readonly onShowLogin: () => void
}): React.JSX.Element {
  const { t } = useTranslation('authentication')
  const [password, setPassword] = useState('')
  const byteLength = passwordByteLength(password)
  const isPasswordValid = isPasswordByteLengthValid(password)

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (isSubmitting || !isPasswordValid) return

    const credentials = readCredentials(event.currentTarget)
    if (credentials) void onSignUp(credentials.email, credentials.password)
  }

  return (
    <form onSubmit={submit}>
      <FormHeader heading={t('signup.heading')} description={t('signup.description')} />
      <div className="flex flex-col gap-6">
        <CredentialFields
          passwordAutoComplete="new-password"
          password={password}
          disabled={isSubmitting}
          onPasswordChange={setPassword}
        />
        <p
          className={isPasswordValid ? 'text-muted-foreground text-sm' : 'text-destructive text-sm'}
        >
          {t('signup.passwordBytes', { count: byteLength })}
        </p>
        {error ? <AuthenticationErrorMessage error={error} context="signup" /> : null}
        <Button type="submit" disabled={isSubmitting || !isPasswordValid}>
          {t(isSubmitting ? 'signup.submitting' : 'signup.submit')}
        </Button>
        <p className="text-muted-foreground text-center text-sm">
          {t('signup.hasAccount')}{' '}
          <button
            type="button"
            className="text-foreground font-medium underline underline-offset-4"
            disabled={isSubmitting}
            onClick={onShowLogin}
          >
            {t('signup.signIn')}
          </button>
        </p>
      </div>
    </form>
  )
}

function SignupVerificationForm({
  error,
  isSubmitting,
  resendSecondsRemaining,
  didResend,
  onVerify,
  onResend,
  onShowLogin,
  onShowRecovery
}: {
  readonly error?: AuthenticationError
  readonly isSubmitting: boolean
  readonly resendSecondsRemaining: number
  readonly didResend: boolean
  readonly onVerify: (code: string) => Promise<void>
  readonly onResend: () => Promise<void>
  readonly onShowLogin: () => void
  readonly onShowRecovery: () => void
}): React.JSX.Element {
  const { t } = useTranslation('authentication')
  const [code, setCode] = useState('')
  const isComplete = /^\d{6}$/.test(code)

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!isSubmitting && isComplete) void onVerify(code)
  }

  return (
    <form onSubmit={submit}>
      <FormHeader heading={t('verification.heading')} description={t('verification.description')} />
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <label htmlFor="authentication-verification-code" className="text-sm font-medium">
            {t('verification.code')}
          </label>
          <input
            id="authentication-verification-code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            disabled={isSubmitting}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/30 h-12 w-full rounded-xl border px-3 text-center text-lg tracking-[0.45em] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <p className="text-muted-foreground text-sm">{t('verification.codeHint')}</p>
        </div>
        {didResend ? (
          <p role="status" className="text-sm">
            {t('verification.resent')}
          </p>
        ) : null}
        {error ? <AuthenticationErrorMessage error={error} context="verification" /> : null}
        <Button type="submit" disabled={isSubmitting || !isComplete}>
          {t(isSubmitting ? 'verification.verifying' : 'verification.verify')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={isSubmitting || resendSecondsRemaining > 0}
          onClick={() => void onResend()}
        >
          {resendSecondsRemaining > 0
            ? t('verification.resendCountdown', { count: resendSecondsRemaining })
            : t('verification.resend')}
        </Button>
        <div className="flex justify-center gap-6 text-sm">
          <button
            type="button"
            className="font-medium underline underline-offset-4"
            disabled={isSubmitting}
            onClick={onShowLogin}
          >
            {t('verification.signIn')}
          </button>
          <button
            type="button"
            className="font-medium underline underline-offset-4"
            disabled={isSubmitting}
            onClick={onShowRecovery}
          >
            {t('login.forgotPassword')}
          </button>
        </div>
      </div>
    </form>
  )
}

function RecoveryRequestForm({
  error,
  isSubmitting,
  onRequestRecovery,
  onShowLogin
}: {
  readonly error?: AuthenticationError
  readonly isSubmitting: boolean
  readonly onRequestRecovery: (email: string) => Promise<void>
  readonly onShowLogin: () => void
}): React.JSX.Element {
  const { t } = useTranslation('authentication')

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (isSubmitting) return

    const email = new FormData(event.currentTarget).get('email')
    if (typeof email === 'string') void onRequestRecovery(email)
  }

  return (
    <form onSubmit={submit}>
      <FormHeader
        heading={t('recovery.request.heading')}
        description={t('recovery.request.description')}
      />
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <label htmlFor="authentication-recovery-email" className="text-sm font-medium">
            {t('login.email')}
          </label>
          <input
            id="authentication-recovery-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            disabled={isSubmitting}
            className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/30 h-10 w-full rounded-xl border px-3 text-sm outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
        {error ? <AuthenticationErrorMessage error={error} context="recovery-request" /> : null}
        <Button type="submit" disabled={isSubmitting}>
          {t(isSubmitting ? 'recovery.request.submitting' : 'recovery.request.submit')}
        </Button>
        <div className="flex justify-center text-sm">
          <button
            type="button"
            className="font-medium underline underline-offset-4"
            disabled={isSubmitting}
            onClick={onShowLogin}
          >
            {t('recovery.request.backToLogin')}
          </button>
        </div>
      </div>
    </form>
  )
}

function RecoveryVerificationForm({
  error,
  isSubmitting,
  onVerify,
  onShowLogin
}: {
  readonly error?: AuthenticationError
  readonly isSubmitting: boolean
  readonly onVerify: (code: string) => Promise<void>
  readonly onShowLogin: () => void
}): React.JSX.Element {
  const { t } = useTranslation('authentication')
  const [code, setCode] = useState('')
  const isComplete = /^\d{6}$/.test(code)

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!isSubmitting && isComplete) void onVerify(code)
  }

  return (
    <form onSubmit={submit}>
      <FormHeader
        heading={t('recovery.verification.heading')}
        description={t('recovery.verification.description')}
      />
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <label htmlFor="authentication-recovery-code" className="text-sm font-medium">
            {t('recovery.verification.code')}
          </label>
          <input
            id="authentication-recovery-code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            disabled={isSubmitting}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/30 h-12 w-full rounded-xl border px-3 text-center text-lg tracking-[0.45em] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <p className="text-muted-foreground text-sm">{t('recovery.verification.codeHint')}</p>
        </div>
        {error ? (
          <AuthenticationErrorMessage error={error} context="recovery-verification" />
        ) : null}
        <Button type="submit" disabled={isSubmitting || !isComplete}>
          {t(isSubmitting ? 'recovery.verification.verifying' : 'recovery.verification.verify')}
        </Button>
        <div className="flex justify-center text-sm">
          <button
            type="button"
            className="font-medium underline underline-offset-4"
            disabled={isSubmitting}
            onClick={onShowLogin}
          >
            {t('recovery.verification.backToLogin')}
          </button>
        </div>
      </div>
    </form>
  )
}

function RecoveryNewPasswordForm({
  error,
  isSubmitting,
  onCompleteRecovery,
  onShowLogin
}: {
  readonly error?: AuthenticationError
  readonly isSubmitting: boolean
  readonly onCompleteRecovery: (newPassword: string) => Promise<void>
  readonly onShowLogin: () => void
}): React.JSX.Element {
  const { t } = useTranslation('authentication')
  const [password, setPassword] = useState('')
  const byteLength = passwordByteLength(password)
  const isPasswordValid = isPasswordByteLengthValid(password)

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!isSubmitting && isPasswordValid) void onCompleteRecovery(password)
  }

  return (
    <form onSubmit={submit}>
      <FormHeader
        heading={t('recovery.newPassword.heading')}
        description={t('recovery.newPassword.description')}
      />
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <label htmlFor="authentication-recovery-new-password" className="text-sm font-medium">
            {t('recovery.newPassword.password')}
          </label>
          <input
            id="authentication-recovery-new-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            disabled={isSubmitting}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/30 h-10 w-full rounded-xl border px-3 text-sm outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
        <p
          className={isPasswordValid ? 'text-muted-foreground text-sm' : 'text-destructive text-sm'}
        >
          {t('recovery.newPassword.passwordBytes', { count: byteLength })}
        </p>
        {error ? <AuthenticationErrorMessage error={error} context="recovery-password" /> : null}
        <Button type="submit" disabled={isSubmitting || !isPasswordValid}>
          {t(isSubmitting ? 'recovery.newPassword.submitting' : 'recovery.newPassword.submit')}
        </Button>
        <div className="flex justify-center text-sm">
          <button
            type="button"
            className="font-medium underline underline-offset-4"
            disabled={isSubmitting}
            onClick={onShowLogin}
          >
            {t('recovery.verification.backToLogin')}
          </button>
        </div>
      </div>
    </form>
  )
}

function CredentialFields({
  disabled,
  passwordAutoComplete,
  password,
  onPasswordChange
}: {
  readonly disabled: boolean
  readonly passwordAutoComplete: 'current-password' | 'new-password'
  readonly password?: string
  readonly onPasswordChange?: (password: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('authentication')

  return (
    <>
      <div className="flex flex-col gap-3">
        <label htmlFor="authentication-email" className="text-sm font-medium">
          {t('login.email')}
        </label>
        <input
          id="authentication-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={disabled}
          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/30 h-10 w-full rounded-xl border px-3 text-sm outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
      <div className="flex flex-col gap-3">
        <label htmlFor="authentication-password" className="text-sm font-medium">
          {t('login.password')}
        </label>
        <input
          id="authentication-password"
          name="password"
          type="password"
          autoComplete={passwordAutoComplete}
          required
          disabled={disabled}
          value={password}
          onChange={onPasswordChange ? (event) => onPasswordChange(event.target.value) : undefined}
          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/30 h-10 w-full rounded-xl border px-3 text-sm outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
    </>
  )
}

function FormHeader({
  heading,
  description
}: {
  readonly heading: string
  readonly description: string
}): React.JSX.Element {
  return (
    <header className="mb-7 text-center">
      <h1 className="text-2xl font-bold">{heading}</h1>
      <p className="text-muted-foreground mt-2 text-sm">{description}</p>
    </header>
  )
}

type AuthenticationErrorContext =
  | 'login'
  | 'signup'
  | 'verification'
  | 'recovery-request'
  | 'recovery-verification'
  | 'recovery-password'

const RATE_LIMITED_KEYS = {
  login: 'login.rateLimited',
  signup: 'signup.rateLimited',
  verification: 'verification.rateLimited',
  'recovery-request': 'recovery.request.rateLimited',
  'recovery-verification': 'recovery.verification.rateLimited',
  'recovery-password': 'recovery.newPassword.rateLimited'
} as const satisfies Record<AuthenticationErrorContext, string>

const SERVICE_ERROR_KEYS = {
  login: 'login.serviceError',
  signup: 'signup.serviceError',
  verification: 'verification.serviceError',
  'recovery-request': 'recovery.request.serviceError',
  'recovery-verification': 'recovery.verification.serviceError',
  'recovery-password': 'recovery.newPassword.serviceError'
} as const satisfies Record<AuthenticationErrorContext, string>

function AuthenticationErrorMessage({
  error,
  context
}: {
  readonly error: AuthenticationError
  readonly context: AuthenticationErrorContext
}): React.JSX.Element {
  const { t } = useTranslation('authentication')
  let message: string

  if (error === 'invalid-credentials') {
    message = t('login.invalidCredentials')
  } else if (error === 'invalid-verification-code') {
    message =
      context === 'recovery-verification'
        ? t('recovery.verification.invalidCode')
        : t('verification.invalidCode')
  } else if (error === 'same-password') {
    message = t('recovery.newPassword.samePassword')
  } else if (error === 'rate-limited') {
    message = t(RATE_LIMITED_KEYS[context])
  } else {
    message = t(SERVICE_ERROR_KEYS[context])
  }

  return (
    <p role="alert" className="text-destructive text-sm">
      {message}
    </p>
  )
}

function readCredentials(
  form: HTMLFormElement
): { readonly email: string; readonly password: string } | undefined {
  const formData = new FormData(form)
  const email = formData.get('email')
  const password = formData.get('password')
  if (typeof email !== 'string' || typeof password !== 'string') return undefined
  return { email, password }
}
