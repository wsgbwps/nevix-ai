import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff } from 'lucide-react'
import { ModeToggle } from '../../../components/mode-toggle'
import { useTheme } from '../../../hooks/use-theme'
import { Button } from '../../../components/ui/button'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel
} from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import { cn } from '../../../lib/utils'
import type {
  AuthenticationError,
  AuthenticationFlow,
  AuthenticationNotice
} from '../model/use-authentication'
import { isPasswordByteLengthValid, passwordByteLengthError } from '../policy/password'
import { RememberedEmailPersistenceNotice } from './remembered-email-persistence-notice'

interface AuthenticationScreenProps {
  readonly status: 'configuration-error' | 'restoring' | 'restore-failure' | 'unauthenticated'
  readonly flow: AuthenticationFlow
  readonly error?: AuthenticationError
  readonly notice?: AuthenticationNotice
  readonly isSubmitting?: boolean
  readonly rememberedEmail?: string
  readonly rememberEmailSelected: boolean
  readonly isRememberedEmailPersistenceUnavailable: boolean
  readonly rememberedEmailPersistenceNoticeSurface: 'login' | 'authenticated' | undefined
  readonly onRetryRestore: () => Promise<void>
  readonly resendSecondsRemaining: number
  readonly resendGeneration: number
  readonly didResend: boolean
  readonly onShowLogin: () => void
  readonly onShowSignUp: () => void
  readonly onShowRecovery: () => void
  readonly onRememberEmailSelectedChange: (selected: boolean) => void
  readonly onRememberedEmailPersistenceNoticeShown: () => void
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
  rememberedEmail,
  rememberEmailSelected,
  isRememberedEmailPersistenceUnavailable,
  rememberedEmailPersistenceNoticeSurface,
  resendSecondsRemaining,
  resendGeneration,
  didResend,
  onRetryRestore,
  onShowLogin,
  onShowSignUp,
  onShowRecovery,
  onRememberEmailSelectedChange,
  onRememberedEmailPersistenceNoticeShown,
  onSignIn,
  onSignUp,
  onVerifySignUp,
  onResendSignUp,
  onRequestRecovery,
  onVerifyRecovery,
  onCompleteRecovery
}: AuthenticationScreenProps): React.JSX.Element {
  const { t } = useTranslation('authentication')
  const { theme } = useTheme()

  return (
    <main className="bg-card relative grid h-svh lg:grid-cols-2">
      <div className="flex flex-col gap-4 overflow-y-auto p-6 md:p-10">
        <div className="flex justify-center md:justify-start">
          <div className="flex items-center gap-2 font-medium">
            <div className="bg-primary text-primary-foreground grid size-6 place-items-center rounded-md text-xs font-bold">
              N
            </div>
            Nevix AI
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs">
            {status !== 'unauthenticated' ? (
              <StatusPanel status={status} onRetryRestore={onRetryRestore} />
            ) : flow === 'login' ? (
              <LoginForm
                error={error}
                notice={notice}
                isSubmitting={isSubmitting}
                rememberedEmail={rememberedEmail}
                rememberEmailSelected={rememberEmailSelected}
                isRememberedEmailPersistenceUnavailable={isRememberedEmailPersistenceUnavailable}
                rememberedEmailPersistenceNoticeSurface={rememberedEmailPersistenceNoticeSurface}
                onSignIn={onSignIn}
                onShowSignUp={onShowSignUp}
                onShowRecovery={onShowRecovery}
                onRememberEmailSelectedChange={onRememberEmailSelectedChange}
                onRememberedEmailPersistenceNoticeShown={onRememberedEmailPersistenceNoticeShown}
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
        </div>
      </div>
      <aside
        aria-hidden="true"
        className="from-primary/70 via-primary/30 to-background relative hidden bg-linear-to-br lg:block"
      >
        <div className="absolute inset-x-10 bottom-10 flex items-center gap-2 text-lg font-medium">
          <div className="bg-primary-foreground text-primary grid size-7 place-items-center rounded-md text-sm font-bold">
            N
          </div>
          Nevix AI
        </div>
      </aside>
      <div className="absolute top-4 right-4 z-10">
        <ModeToggle label={t(theme === 'dark' ? 'theme.switchToLight' : 'theme.switchToDark')} />
      </div>
    </main>
  )
}

function StatusPanel({
  status,
  onRetryRestore
}: {
  readonly status: 'configuration-error' | 'restoring' | 'restore-failure'
  readonly onRetryRestore: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('authentication')
  const translationKey =
    status === 'restoring'
      ? 'restoring'
      : status === 'restore-failure'
        ? 'restoreFailure'
        : 'configurationError'

  return (
    <div className="text-center">
      <h1 className="text-2xl font-bold">{t(`${translationKey}.heading`)}</h1>
      <p className="text-muted-foreground mt-2 text-sm">{t(`${translationKey}.description`)}</p>
      {status === 'restore-failure' ? (
        <Button className="mt-6" onClick={() => void onRetryRestore()}>
          {t('restoreFailure.retry')}
        </Button>
      ) : null}
    </div>
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
  rememberedEmail,
  rememberEmailSelected,
  isRememberedEmailPersistenceUnavailable,
  rememberedEmailPersistenceNoticeSurface,
  onSignIn,
  onShowSignUp,
  onShowRecovery,
  onRememberEmailSelectedChange,
  onRememberedEmailPersistenceNoticeShown
}: {
  readonly error?: AuthenticationError
  readonly notice?: AuthenticationNotice
  readonly isSubmitting: boolean
  readonly rememberedEmail?: string
  readonly rememberEmailSelected: boolean
  readonly isRememberedEmailPersistenceUnavailable: boolean
  readonly rememberedEmailPersistenceNoticeSurface: 'login' | 'authenticated' | undefined
  readonly onSignIn: (email: string, password: string) => Promise<void>
  readonly onShowSignUp: () => void
  readonly onShowRecovery: () => void
  readonly onRememberEmailSelectedChange: (selected: boolean) => void
  readonly onRememberedEmailPersistenceNoticeShown: () => void
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
      <FieldGroup>
        {notice ? (
          <p role="status" className="text-muted-foreground text-sm">
            {t(LOGIN_NOTICE_KEYS[notice])}
          </p>
        ) : null}
        <RememberedEmailPersistenceNotice
          surface="login"
          isPersistenceUnavailable={isRememberedEmailPersistenceUnavailable}
          noticeSurface={rememberedEmailPersistenceNoticeSurface}
          onShown={onRememberedEmailPersistenceNoticeShown}
        />
        <CredentialFields
          passwordAutoComplete="current-password"
          disabled={isSubmitting}
          emailDefaultValue={rememberedEmail}
          emailAutoFocus={!rememberedEmail}
          passwordAutoFocus={Boolean(rememberedEmail)}
          onForgotPassword={onShowRecovery}
        />
        <label className="flex items-center gap-2 text-sm" htmlFor="authentication-remember-email">
          <input
            id="authentication-remember-email"
            type="checkbox"
            aria-label={t('login.rememberEmailAria')}
            checked={rememberEmailSelected}
            disabled={isSubmitting}
            onChange={(event) => onRememberEmailSelectedChange(event.target.checked)}
          />
          {t('login.rememberEmail')}
        </label>
        {error ? <AuthenticationErrorMessage error={error} context="login" /> : null}
        <Button type="submit" disabled={isSubmitting}>
          {t(isSubmitting ? 'login.submitting' : 'login.submit')}
        </Button>
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
      </FieldGroup>
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
  const [confirmPassword, setConfirmPassword] = useState('')
  const isPasswordValid = isPasswordByteLengthValid(password)
  const isConfirmMismatch = confirmPassword !== '' && confirmPassword !== password
  const canSubmit = isPasswordValid && confirmPassword === password

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (isSubmitting || !canSubmit) return

    const credentials = readCredentials(event.currentTarget)
    if (credentials) void onSignUp(credentials.email, credentials.password)
  }

  return (
    <form onSubmit={submit}>
      <FormHeader heading={t('signup.heading')} description={t('signup.description')} />
      <FieldGroup>
        <CredentialFields
          passwordAutoComplete="new-password"
          password={password}
          disabled={isSubmitting}
          onPasswordChange={setPassword}
        />
        <PasswordPolicyFeedback password={password} />
        <Field>
          <FieldLabel htmlFor="authentication-confirm-password">
            {t('signup.confirmPassword')}
          </FieldLabel>
          <PasswordInput
            id="authentication-confirm-password"
            name="confirmPassword"
            autoComplete="new-password"
            disabled={isSubmitting}
            aria-invalid={isConfirmMismatch || undefined}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
          {isConfirmMismatch ? (
            <FieldError>{t('signup.confirmPasswordMismatch')}</FieldError>
          ) : null}
        </Field>
        {error ? <AuthenticationErrorMessage error={error} context="signup" /> : null}
        <Button type="submit" disabled={isSubmitting || !canSubmit}>
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
      </FieldGroup>
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
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="authentication-verification-code">
            {t('verification.code')}
          </FieldLabel>
          <Input
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
            className="h-12 text-center text-lg tracking-[0.45em]"
          />
          <FieldDescription>{t('verification.codeHint')}</FieldDescription>
        </Field>
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
      </FieldGroup>
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
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="authentication-recovery-email">{t('login.email')}</FieldLabel>
          <Input
            id="authentication-recovery-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            disabled={isSubmitting}
          />
        </Field>
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
      </FieldGroup>
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
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="authentication-recovery-code">
            {t('recovery.verification.code')}
          </FieldLabel>
          <Input
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
            className="h-12 text-center text-lg tracking-[0.45em]"
          />
          <FieldDescription>{t('recovery.verification.codeHint')}</FieldDescription>
        </Field>
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
      </FieldGroup>
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
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="authentication-recovery-new-password">
            {t('recovery.newPassword.password')}
          </FieldLabel>
          <PasswordInput
            id="authentication-recovery-new-password"
            name="password"
            autoComplete="new-password"
            required
            disabled={isSubmitting}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <PasswordPolicyFeedback password={password} />
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
      </FieldGroup>
    </form>
  )
}

function CredentialFields({
  disabled,
  passwordAutoComplete,
  password,
  onPasswordChange,
  onForgotPassword,
  emailDefaultValue,
  emailAutoFocus = false,
  passwordAutoFocus = false
}: {
  readonly disabled: boolean
  readonly passwordAutoComplete: 'current-password' | 'new-password'
  readonly password?: string
  readonly onPasswordChange?: (password: string) => void
  readonly onForgotPassword?: () => void
  readonly emailDefaultValue?: string
  readonly emailAutoFocus?: boolean
  readonly passwordAutoFocus?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('authentication')

  return (
    <>
      <Field>
        <FieldLabel htmlFor="authentication-email">{t('login.email')}</FieldLabel>
        <Input
          id="authentication-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={disabled}
          defaultValue={emailDefaultValue}
          autoFocus={emailAutoFocus}
        />
      </Field>
      <Field>
        <div className="flex items-center">
          <FieldLabel htmlFor="authentication-password">{t('login.password')}</FieldLabel>
          {onForgotPassword ? (
            <button
              type="button"
              className="ml-auto text-sm underline-offset-4 hover:underline"
              disabled={disabled}
              onClick={onForgotPassword}
            >
              {t('login.forgotPassword')}
            </button>
          ) : null}
        </div>
        <PasswordInput
          id="authentication-password"
          name="password"
          autoComplete={passwordAutoComplete}
          required
          disabled={disabled}
          autoFocus={passwordAutoFocus}
          value={password}
          onChange={onPasswordChange ? (event) => onPasswordChange(event.target.value) : undefined}
        />
      </Field>
    </>
  )
}

function PasswordInput({
  className,
  disabled,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type'>): React.JSX.Element {
  const { t } = useTranslation('authentication')
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    if (!isVisible) return

    const hide = (): void => setIsVisible(false)
    const stopListeningForWindowDeactivation = window.api.on('window:deactivated', hide)
    window.addEventListener('blur', hide)
    document.addEventListener('visibilitychange', hide)
    return () => {
      stopListeningForWindowDeactivation()
      window.removeEventListener('blur', hide)
      document.removeEventListener('visibilitychange', hide)
    }
  }, [isVisible])

  return (
    <div className="relative">
      <Input
        {...props}
        type={isVisible ? 'text' : 'password'}
        disabled={disabled}
        className={cn('pr-10', className)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute top-1/2 right-0.5 -translate-y-1/2"
        disabled={disabled}
        aria-label={t(isVisible ? 'passwordVisibility.hide' : 'passwordVisibility.show')}
        aria-pressed={isVisible}
        onClick={() => setIsVisible((visible) => !visible)}
      >
        {isVisible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </Button>
    </div>
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

function PasswordPolicyFeedback({ password }: { readonly password: string }): React.JSX.Element {
  const { t } = useTranslation('authentication')
  const lengthError = password === '' ? undefined : passwordByteLengthError(password)

  return (
    <div>
      <FieldDescription>{t('passwordPolicy.recommendation')}</FieldDescription>
      {lengthError ? (
        <FieldError>
          {t(`passwordPolicy.${lengthError === 'too-short' ? 'tooShort' : 'tooLong'}`)}
        </FieldError>
      ) : null}
    </div>
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
  } else if (error === 'password-too-short') {
    message = t('passwordPolicy.tooShort')
  } else if (error === 'password-leaked') {
    message = t('passwordPolicy.leaked')
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
