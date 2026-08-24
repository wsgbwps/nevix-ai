import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff } from 'lucide-react'
import { ModeToggle } from '../../../components/mode-toggle'
import { useTheme } from '../../../hooks/use-theme'
import { Button } from '../../../components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import { cn } from '../../../lib/utils'
import type {
  AuthenticationError,
  AuthenticationNotice,
  InstanceSetupState
} from '../model/use-authentication'
import { isPasswordByteLengthValid, passwordByteLengthError } from '../policy/password'
import { RememberedEmailPersistenceNotice } from './remembered-email-persistence-notice'

interface AuthenticationScreenProps {
  readonly status: 'restoring' | 'restore-failure' | 'unauthenticated' | 'password-change-required'
  readonly error?: AuthenticationError
  readonly notice?: AuthenticationNotice
  readonly isSubmitting?: boolean
  readonly instanceSetup: InstanceSetupState
  readonly setupCodeRequired?: boolean
  readonly rememberedEmail?: string
  readonly rememberEmailSelected: boolean
  readonly isRememberedEmailPersistenceUnavailable: boolean
  readonly rememberedEmailPersistenceNoticeSurface: 'login' | 'authenticated' | undefined
  readonly onRetryRestore: () => Promise<void>
  readonly onRetrySetupProbe: () => void
  readonly onRememberEmailSelectedChange: (selected: boolean) => void
  readonly onRememberedEmailPersistenceNoticeShown: () => void
  readonly onDismissError: () => void
  readonly onSignIn: (email: string, password: string) => Promise<void>
  readonly onRegister: (
    email: string,
    password: string,
    joinCode: string,
    displayName: string
  ) => Promise<void>
  readonly onInitialize: (
    email: string,
    password: string,
    setupCode: string | undefined,
    displayName: string
  ) => Promise<void>
  readonly onCompletePasswordChange: (currentPassword: string, newPassword: string) => Promise<void>
  readonly onSignOut: () => Promise<void>
}

export function AuthenticationScreen({
  status,
  error,
  notice,
  isSubmitting = false,
  instanceSetup,
  setupCodeRequired = false,
  rememberedEmail,
  rememberEmailSelected,
  isRememberedEmailPersistenceUnavailable,
  rememberedEmailPersistenceNoticeSurface,
  onRetryRestore,
  onRetrySetupProbe,
  onRememberEmailSelectedChange,
  onRememberedEmailPersistenceNoticeShown,
  onDismissError,
  onSignIn,
  onRegister,
  onInitialize,
  onCompletePasswordChange,
  onSignOut
}: AuthenticationScreenProps): React.JSX.Element {
  const { t } = useTranslation('authentication')
  const { theme } = useTheme()
  // Both unauthenticated surfaces share the model-owned error slot; switching modes dismisses
  // the stale verdict so one form's failure never shows inside the other.
  const [mode, setMode] = useState<'login' | 'register'>('login')

  function switchMode(nextMode: 'login' | 'register'): void {
    onDismissError()
    setMode(nextMode)
  }

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
            {status === 'unauthenticated' ? (
              instanceSetup === 'uninitialized' ? (
                <SetupWizardForm
                  error={error}
                  isSubmitting={isSubmitting}
                  setupCodeRequired={setupCodeRequired}
                  onInitialize={onInitialize}
                />
              ) : instanceSetup === 'probe-failed' ? (
                <SetupProbeFailurePanel onRetry={onRetrySetupProbe} />
              ) : mode === 'register' ? (
                <RegistrationForm
                  error={error}
                  isSubmitting={isSubmitting}
                  onRegister={onRegister}
                  onBackToLogin={() => switchMode('login')}
                />
              ) : (
                <LoginForm
                  error={error}
                  notice={notice}
                  isSubmitting={isSubmitting}
                  rememberedEmail={rememberedEmail}
                  rememberEmailSelected={rememberEmailSelected}
                  isRememberedEmailPersistenceUnavailable={isRememberedEmailPersistenceUnavailable}
                  rememberedEmailPersistenceNoticeSurface={rememberedEmailPersistenceNoticeSurface}
                  onSignIn={onSignIn}
                  onSwitchToRegister={() => switchMode('register')}
                  onRememberEmailSelectedChange={onRememberEmailSelectedChange}
                  onRememberedEmailPersistenceNoticeShown={onRememberedEmailPersistenceNoticeShown}
                />
              )
            ) : status === 'password-change-required' ? (
              <FirstLoginPasswordChangeForm
                error={error}
                isSubmitting={isSubmitting}
                onCompletePasswordChange={onCompletePasswordChange}
                onSignOut={onSignOut}
              />
            ) : (
              <StatusPanel status={status} onRetryRestore={onRetryRestore} />
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
  readonly status: 'restoring' | 'restore-failure'
  readonly onRetryRestore: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('authentication')
  const translationKey = status === 'restoring' ? 'restoring' : 'restoreFailure'

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
  'remote-sign-out-delayed': 'login.remoteSignOutDelayed'
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
  onSwitchToRegister,
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
  readonly onSwitchToRegister: () => void
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
        <Field>
          <FieldLabel htmlFor="authentication-email">{t('login.email')}</FieldLabel>
          <Input
            id="authentication-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            disabled={isSubmitting}
            defaultValue={rememberedEmail}
            autoFocus={!rememberedEmail}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="authentication-password">{t('login.password')}</FieldLabel>
          <PasswordInput
            id="authentication-password"
            name="password"
            autoComplete="current-password"
            required
            disabled={isSubmitting}
            autoFocus={Boolean(rememberedEmail)}
          />
        </Field>
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
        <div className="flex justify-center text-sm">
          <button
            type="button"
            className="font-medium underline underline-offset-4"
            disabled={isSubmitting}
            onClick={onSwitchToRegister}
          >
            {t('register.switchToRegister')}
          </button>
        </div>
      </FieldGroup>
    </form>
  )
}

function SetupProbeFailurePanel({ onRetry }: { readonly onRetry: () => void }): React.JSX.Element {
  const { t } = useTranslation('authentication')

  return (
    <div className="text-center">
      <h1 className="text-2xl font-bold">{t('setupProbeFailure.heading')}</h1>
      <p className="text-muted-foreground mt-2 text-sm">{t('setupProbeFailure.description')}</p>
      <Button className="mt-6" onClick={onRetry}>
        {t('setupProbeFailure.retry')}
      </Button>
    </div>
  )
}

function SetupWizardForm({
  error,
  isSubmitting,
  setupCodeRequired,
  onInitialize
}: {
  readonly error?: AuthenticationError
  readonly isSubmitting: boolean
  readonly setupCodeRequired: boolean
  readonly onInitialize: (
    email: string,
    password: string,
    setupCode: string | undefined,
    displayName: string
  ) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('authentication')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [setupCode, setSetupCode] = useState('')
  const [displayName, setDisplayName] = useState('')
  const isPasswordValid = isPasswordByteLengthValid(password)
  const isConfirmMismatch = confirmPassword !== '' && confirmPassword !== password
  const isSetupCodeReady = setupCode.trim() !== ''
  // A protected deployment demands the one-time code the operations log
  // disclosed; an open claim has no code field at all.
  const canSubmit =
    email.trim() !== '' &&
    isPasswordValid &&
    confirmPassword !== '' &&
    confirmPassword === password &&
    (!setupCodeRequired || isSetupCodeReady)

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (isSubmitting || !canSubmit) return

    void onInitialize(
      email,
      password,
      setupCodeRequired ? setupCode.trim() : undefined,
      displayName
    )
  }

  return (
    <form onSubmit={submit}>
      <FormHeader
        heading={t('setupWizard.heading')}
        description={t(
          setupCodeRequired ? 'setupWizard.protectedDescription' : 'setupWizard.openDescription'
        )}
      />
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="setup-wizard-email">{t('setupWizard.email')}</FieldLabel>
          <Input
            id="setup-wizard-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            disabled={isSubmitting}
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="setup-wizard-password">{t('setupWizard.password')}</FieldLabel>
          <PasswordInput
            id="setup-wizard-password"
            name="password"
            autoComplete="new-password"
            required
            disabled={isSubmitting}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <PasswordPolicyFeedback password={password} />
        </Field>
        <Field>
          <FieldLabel htmlFor="setup-wizard-confirm-password">
            {t('setupWizard.confirmPassword')}
          </FieldLabel>
          <PasswordInput
            id="setup-wizard-confirm-password"
            name="confirmPassword"
            autoComplete="new-password"
            required
            disabled={isSubmitting}
            aria-invalid={isConfirmMismatch || undefined}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
          {isConfirmMismatch ? (
            <FieldError>{t('setupWizard.confirmPasswordMismatch')}</FieldError>
          ) : null}
        </Field>
        {setupCodeRequired ? (
          <Field>
            <FieldLabel htmlFor="setup-wizard-code">{t('setupWizard.setupCode')}</FieldLabel>
            <Input
              id="setup-wizard-code"
              name="setupCode"
              type="text"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              required
              disabled={isSubmitting}
              value={setupCode}
              onChange={(event) => setSetupCode(event.target.value)}
            />
          </Field>
        ) : null}
        <Field>
          <FieldLabel htmlFor="setup-wizard-display-name">
            {t('setupWizard.displayName')}
          </FieldLabel>
          <Input
            id="setup-wizard-display-name"
            name="displayName"
            type="text"
            maxLength={128}
            disabled={isSubmitting}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
        {error ? <AuthenticationErrorMessage error={error} context="setup-wizard" /> : null}
        <Button type="submit" disabled={isSubmitting || !canSubmit}>
          {t(isSubmitting ? 'setupWizard.submitting' : 'setupWizard.submit')}
        </Button>
      </FieldGroup>
    </form>
  )
}

function RegistrationForm({
  error,
  isSubmitting,
  onRegister,
  onBackToLogin
}: {
  readonly error?: AuthenticationError
  readonly isSubmitting: boolean
  readonly onRegister: (
    email: string,
    password: string,
    joinCode: string,
    displayName: string
  ) => Promise<void>
  readonly onBackToLogin: () => void
}): React.JSX.Element {
  const { t } = useTranslation('authentication')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [displayName, setDisplayName] = useState('')
  const isPasswordValid = isPasswordByteLengthValid(password)
  const isConfirmMismatch = confirmPassword !== '' && confirmPassword !== password
  const isJoinCodeReady = joinCode.trim() !== ''
  const canSubmit =
    email.trim() !== '' &&
    isPasswordValid &&
    confirmPassword !== '' &&
    confirmPassword === password &&
    isJoinCodeReady

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (isSubmitting || !canSubmit) return

    void onRegister(email, password, joinCode.trim(), displayName)
  }

  return (
    <form onSubmit={submit}>
      <FormHeader heading={t('register.heading')} description={t('register.description')} />
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="registration-email">{t('register.email')}</FieldLabel>
          <Input
            id="registration-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            disabled={isSubmitting}
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="registration-password">{t('register.password')}</FieldLabel>
          <PasswordInput
            id="registration-password"
            name="password"
            autoComplete="new-password"
            required
            disabled={isSubmitting}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <PasswordPolicyFeedback password={password} />
        </Field>
        <Field>
          <FieldLabel htmlFor="registration-confirm-password">
            {t('register.confirmPassword')}
          </FieldLabel>
          <PasswordInput
            id="registration-confirm-password"
            name="confirmPassword"
            autoComplete="new-password"
            required
            disabled={isSubmitting}
            aria-invalid={isConfirmMismatch || undefined}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
          {isConfirmMismatch ? (
            <FieldError>{t('register.confirmPasswordMismatch')}</FieldError>
          ) : null}
        </Field>
        <Field>
          <FieldLabel htmlFor="registration-join-code">{t('register.joinCode')}</FieldLabel>
          <Input
            id="registration-join-code"
            name="joinCode"
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={64}
            required
            disabled={isSubmitting}
            value={joinCode}
            onChange={(event) => setJoinCode(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="registration-display-name">{t('register.displayName')}</FieldLabel>
          <Input
            id="registration-display-name"
            name="displayName"
            type="text"
            maxLength={128}
            disabled={isSubmitting}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
        {error ? <AuthenticationErrorMessage error={error} context="register" /> : null}
        <Button type="submit" disabled={isSubmitting || !canSubmit}>
          {t(isSubmitting ? 'register.submitting' : 'register.submit')}
        </Button>
        <div className="flex justify-center text-sm">
          <button
            type="button"
            className="font-medium underline underline-offset-4"
            disabled={isSubmitting}
            onClick={onBackToLogin}
          >
            {t('register.backToLogin')}
          </button>
        </div>
      </FieldGroup>
    </form>
  )
}

function FirstLoginPasswordChangeForm({
  error,
  isSubmitting,
  onCompletePasswordChange,
  onSignOut
}: {
  readonly error?: AuthenticationError
  readonly isSubmitting: boolean
  readonly onCompletePasswordChange: (currentPassword: string, newPassword: string) => Promise<void>
  readonly onSignOut: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('authentication')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const isNewPasswordValid = isPasswordByteLengthValid(newPassword)
  const isConfirmMismatch = confirmPassword !== '' && confirmPassword !== newPassword
  const canSubmit = currentPassword !== '' && isNewPasswordValid && confirmPassword === newPassword

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (isSubmitting || !canSubmit) return

    void onCompletePasswordChange(currentPassword, newPassword)
  }

  return (
    <form onSubmit={submit}>
      <FormHeader
        heading={t('passwordChange.heading')}
        description={t('passwordChange.description')}
      />
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="authentication-current-password">
            {t('passwordChange.currentPassword')}
          </FieldLabel>
          <PasswordInput
            id="authentication-current-password"
            name="currentPassword"
            autoComplete="current-password"
            required
            disabled={isSubmitting}
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="authentication-new-password">
            {t('passwordChange.newPassword')}
          </FieldLabel>
          <PasswordInput
            id="authentication-new-password"
            name="newPassword"
            autoComplete="new-password"
            required
            disabled={isSubmitting}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <PasswordPolicyFeedback password={newPassword} />
        </Field>
        <Field>
          <FieldLabel htmlFor="authentication-confirm-password">
            {t('passwordChange.confirmPassword')}
          </FieldLabel>
          <PasswordInput
            id="authentication-confirm-password"
            name="confirmPassword"
            autoComplete="new-password"
            required
            disabled={isSubmitting}
            aria-invalid={isConfirmMismatch || undefined}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
          {isConfirmMismatch ? (
            <FieldError>{t('passwordChange.confirmPasswordMismatch')}</FieldError>
          ) : null}
        </Field>
        {error ? <AuthenticationErrorMessage error={error} context="password-change" /> : null}
        <Button type="submit" disabled={isSubmitting || !canSubmit}>
          {t(isSubmitting ? 'passwordChange.submitting' : 'passwordChange.submit')}
        </Button>
        <div className="flex justify-center text-sm">
          <button
            type="button"
            className="font-medium underline underline-offset-4"
            disabled={isSubmitting}
            onClick={() => void onSignOut()}
          >
            {t('passwordChange.signOutInstead')}
          </button>
        </div>
      </FieldGroup>
    </form>
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
      <button
        type="button"
        disabled={disabled}
        aria-label={t(isVisible ? 'passwordVisibility.hide' : 'passwordVisibility.show')}
        aria-pressed={isVisible}
        onClick={() => setIsVisible((visible) => !visible)}
        className="focus-visible:border-ring focus-visible:ring-ring/50 hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 absolute top-1/2 right-0.5 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-[min(var(--radius-md),10px)] outline-none focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
      >
        {isVisible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </button>
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

function PasswordPolicyFeedback({
  password
}: {
  readonly password: string
}): React.JSX.Element | null {
  const { t } = useTranslation('authentication')
  const lengthError = password === '' ? undefined : passwordByteLengthError(password)

  if (!lengthError) return null

  return (
    <FieldError>
      {t('passwordPolicy.recommendation')}{' '}
      {t(`passwordPolicy.${lengthError === 'too-short' ? 'tooShort' : 'tooLong'}`)}
    </FieldError>
  )
}

type AuthenticationErrorContext = 'login' | 'password-change' | 'register' | 'setup-wizard'

const ERROR_CONTEXT_KEYS = {
  login: 'login',
  'password-change': 'passwordChange',
  register: 'register',
  'setup-wizard': 'setupWizard'
} as const

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
    message =
      context === 'password-change'
        ? t('passwordChange.invalidCurrentPassword')
        : t('login.invalidCredentials')
  } else if (error === 'account-disabled') {
    message = t('login.accountDisabled')
  } else if (error === 'invalid-password') {
    message = t('passwordPolicy.invalidPassword')
  } else if (error === 'password-too-short') {
    message = t('passwordPolicy.tooShort')
  } else if (error === 'password-too-long') {
    message = t('passwordPolicy.tooLong')
  } else if (error === 'invalid-join-code') {
    message = t('register.invalidJoinCode')
  } else if (error === 'email-taken') {
    message = t('register.emailTaken')
  } else if (error === 'invalid-setup-code') {
    message = t('setupWizard.invalidSetupCode')
  } else if (error === 'instance-already-initialized') {
    message = t('setupWizard.instanceAlreadyInitialized')
  } else if (error === 'rate-limited') {
    message = t(`${ERROR_CONTEXT_KEYS[context]}.rateLimited`)
  } else {
    message = t(`${ERROR_CONTEXT_KEYS[context]}.serviceError`)
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
