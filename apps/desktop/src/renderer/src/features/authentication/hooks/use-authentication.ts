import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthApiError, type AuthError, type SupabaseClient } from '@supabase/supabase-js'
import { createAuthenticationClient } from '../api/client'
import { readSupabasePublicConfig } from '../api/environment'
import { isPasswordByteLengthValid } from '../policy/password'
import {
  clearPersistedSession,
  isSessionPersistenceUnavailable,
  readPersistedSession
} from '../session/persisted-session'
import type { SupabasePublicConfig } from '../../../../../shared/config/supabase-public-config'

export type AuthenticationStatus =
  | 'restoring'
  | 'configuration-error'
  | 'restore-failure'
  | 'unauthenticated'
  | 'authenticated'

export type AuthenticationFlow = 'login' | 'signup' | 'signup-verification'

export type AuthenticationError =
  | 'invalid-credentials'
  | 'invalid-verification-code'
  | 'rate-limited'
  | 'service-unavailable'

export type AuthenticationNotice = 'session-expired' | 'remote-sign-out-delayed'

interface Authentication {
  readonly status: AuthenticationStatus
  readonly flow: AuthenticationFlow
  readonly error: AuthenticationError | undefined
  readonly notice: AuthenticationNotice | undefined
  readonly isSubmitting: boolean
  readonly isSessionPersistenceUnavailable: boolean
  readonly resendSecondsRemaining: number
  readonly resendGeneration: number
  readonly didResend: boolean
  readonly showLogin: () => void
  readonly showSignUp: () => void
  readonly retryRestore: () => Promise<void>
  readonly signIn: (email: string, password: string) => Promise<void>
  readonly signUp: (email: string, password: string) => Promise<void>
  readonly verifySignUp: (code: string) => Promise<void>
  readonly resendSignUp: () => Promise<void>
  readonly signOut: () => Promise<void>
}

const INVALID_CREDENTIAL_CODES = new Set([
  'email_not_confirmed',
  'invalid_credentials',
  'user_not_found'
])
const SAFE_SIGNUP_CONFLICT_CODES = new Set(['email_exists', 'user_already_exists'])
const INVALID_VERIFICATION_CODES = new Set([
  'bad_code_verifier',
  'invalid_otp',
  'otp_expired',
  'token_expired'
])
const RATE_LIMIT_CODES = new Set([
  'over_email_send_rate_limit',
  'over_request_rate_limit',
  'request_rate_limit_reached'
])
const MINIMUM_INITIALIZATION_DISPLAY_MS = 500
const RESEND_COOLDOWN_MS = 60_000

export function useAuthentication(): Authentication {
  const [status, setStatus] = useState<AuthenticationStatus>('restoring')
  const [flow, setFlow] = useState<AuthenticationFlow>('login')
  const [error, setError] = useState<AuthenticationError>()
  const [notice, setNotice] = useState<AuthenticationNotice>()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [persistenceUnavailable, setPersistenceUnavailable] = useState(false)
  const [verificationEmail, setVerificationEmail] = useState<string>()
  const [resendAvailableAt, setResendAvailableAt] = useState<number>()
  const [resendSecondsRemaining, setResendSecondsRemaining] = useState(0)
  const [resendGeneration, setResendGeneration] = useState(0)
  const [didResend, setDidResend] = useState(false)
  const clientRef = useRef<SupabaseClient | null>(null)
  const authSubscriptionRef = useRef<{ unsubscribe: () => void } | null>(null)
  const submissionRef = useRef(false)
  const hasInitializedRef = useRef(false)
  const restoreInProgressRef = useRef(false)
  const signOutInProgressRef = useRef(false)

  const resetSignUpVerification = useCallback((): void => {
    setVerificationEmail(undefined)
    setDidResend(false)
    setResendAvailableAt(undefined)
    setResendSecondsRemaining(0)
  }, [])

  const handleProviderSignedOut = useCallback((): void => {
    if (restoreInProgressRef.current || signOutInProgressRef.current) return

    void clearPersistedSession()
      .catch(() => undefined)
      .finally(() => {
        setError(undefined)
        setNotice('session-expired')
        setPersistenceUnavailable(false)
        setStatus('unauthenticated')
        setFlow('login')
        resetSignUpVerification()
      })
  }, [resetSignUpVerification])

  const enterAuthenticatedShell = useCallback((): void => {
    setPersistenceUnavailable(isSessionPersistenceUnavailable())
    setNotice(undefined)
    setStatus('authenticated')
  }, [])

  const restore = useCallback(async (): Promise<void> => {
    if (restoreInProgressRef.current) return
    restoreInProgressRef.current = true

    setStatus('restoring')
    setError(undefined)

    try {
      const publicConfig = readSupabasePublicConfig()
      if (!publicConfig) {
        setStatus('configuration-error')
        return
      }

      const stored = await readPersistedSession()
      const isUnusable = stored.outcome === 'unreadable'
      if (isUnusable) await clearPersistedSession()

      // A retry must reach the network again, so each attempt starts from a client that has no
      // memory of the previous refresh failure.
      const client = replaceAuthenticationClient(
        clientRef,
        authSubscriptionRef,
        publicConfig,
        handleProviderSignedOut
      )

      if (stored.outcome !== 'session') {
        setNotice(isUnusable ? 'session-expired' : undefined)
        setStatus('unauthenticated')
        return
      }

      const { data, error: refreshError } = await client.auth.refreshSession()
      if (data.session) {
        enterAuthenticatedShell()
        return
      }

      if (!isTerminalRestoreFailure(refreshError)) {
        setStatus('restore-failure')
        return
      }

      await clearPersistedSession()
      setNotice('session-expired')
      setStatus('unauthenticated')
    } catch {
      setStatus('restore-failure')
    } finally {
      restoreInProgressRef.current = false
    }
  }, [enterAuthenticatedShell, handleProviderSignedOut])

  useEffect(() => {
    if (hasInitializedRef.current) return
    hasInitializedRef.current = true

    // The restoring boundary stays visible long enough that no launch flashes another boundary.
    const initialized = new Promise<void>((resolve) => {
      setTimeout(resolve, MINIMUM_INITIALIZATION_DISPLAY_MS)
    })
    void initialized.then(() => restore())
  }, [restore])

  useEffect(
    () => () => {
      authSubscriptionRef.current?.unsubscribe()
      void clientRef.current?.auth.stopAutoRefresh()
    },
    []
  )

  useEffect(() => {
    if (resendAvailableAt === undefined) return

    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((resendAvailableAt - Date.now()) / 1000))
      setResendSecondsRemaining(remaining)
      if (remaining === 0) clearInterval(interval)
    }, 250)
    return () => clearInterval(interval)
  }, [resendAvailableAt])

  const showLogin = useCallback((): void => {
    setFlow('login')
    setError(undefined)
    resetSignUpVerification()
  }, [resetSignUpVerification])

  const showSignUp = useCallback((): void => {
    setFlow('signup')
    setError(undefined)
    setNotice(undefined)
    resetSignUpVerification()
  }, [resetSignUpVerification])

  const signIn = useCallback(
    async (email: string, password: string): Promise<void> => {
      const client = clientRef.current
      if (!client || submissionRef.current) return

      submissionRef.current = true
      setIsSubmitting(true)
      setError(undefined)

      try {
        const { data, error: signInError } = await client.auth.signInWithPassword({
          email,
          password
        })

        if (signInError || !data.session) {
          const isInvalidCredential =
            signInError instanceof AuthApiError &&
            signInError.code !== undefined &&
            INVALID_CREDENTIAL_CODES.has(signInError.code)
          setError(isInvalidCredential ? 'invalid-credentials' : 'service-unavailable')
          return
        }

        enterAuthenticatedShell()
      } catch {
        setError('service-unavailable')
      } finally {
        submissionRef.current = false
        setIsSubmitting(false)
      }
    },
    [enterAuthenticatedShell]
  )

  const signUp = useCallback(async (email: string, password: string): Promise<void> => {
    const client = clientRef.current
    if (!client || submissionRef.current || !isPasswordByteLengthValid(password)) return

    submissionRef.current = true
    signOutInProgressRef.current = true
    setIsSubmitting(true)
    setError(undefined)

    try {
      const { error: signUpError } = await client.auth.signUp({ email, password })

      if (
        signUpError &&
        !(
          signUpError instanceof AuthApiError &&
          signUpError.code !== undefined &&
          SAFE_SIGNUP_CONFLICT_CODES.has(signUpError.code)
        )
      ) {
        setError(isRateLimited(signUpError) ? 'rate-limited' : 'service-unavailable')
        return
      }

      setVerificationEmail(email)
      setFlow('signup-verification')
      setResendAvailableAt(Date.now() + RESEND_COOLDOWN_MS)
      setResendSecondsRemaining(RESEND_COOLDOWN_MS / 1000)
      setResendGeneration(0)
      setDidResend(false)
    } catch {
      setError('service-unavailable')
    } finally {
      submissionRef.current = false
      setIsSubmitting(false)
    }
  }, [])

  const verifySignUp = useCallback(
    async (code: string): Promise<void> => {
      const client = clientRef.current
      if (!client || !verificationEmail || submissionRef.current || !/^\d{6}$/.test(code)) {
        return
      }

      submissionRef.current = true
      setIsSubmitting(true)
      setError(undefined)

      try {
        const { data, error: verificationError } = await client.auth.verifyOtp({
          email: verificationEmail,
          token: code,
          type: 'email'
        })

        if (verificationError || !data.session) {
          if (isRateLimited(verificationError)) {
            setError('rate-limited')
          } else if (
            verificationError instanceof AuthApiError &&
            verificationError.code !== undefined &&
            INVALID_VERIFICATION_CODES.has(verificationError.code)
          ) {
            setError('invalid-verification-code')
          } else {
            setError('service-unavailable')
          }
          return
        }

        enterAuthenticatedShell()
        setFlow('login')
        resetSignUpVerification()
      } catch {
        setError('service-unavailable')
      } finally {
        submissionRef.current = false
        setIsSubmitting(false)
      }
    },
    [enterAuthenticatedShell, resetSignUpVerification, verificationEmail]
  )

  const resendSignUp = useCallback(async (): Promise<void> => {
    const client = clientRef.current
    if (!client || !verificationEmail || submissionRef.current || resendSecondsRemaining > 0) {
      return
    }

    submissionRef.current = true
    setIsSubmitting(true)
    setError(undefined)

    try {
      const { error: resendError } = await client.auth.resend({
        type: 'signup',
        email: verificationEmail
      })

      if (resendError) {
        setError(isRateLimited(resendError) ? 'rate-limited' : 'service-unavailable')
        return
      }

      setDidResend(true)
      setResendGeneration((generation) => generation + 1)
      setResendAvailableAt(Date.now() + RESEND_COOLDOWN_MS)
      setResendSecondsRemaining(RESEND_COOLDOWN_MS / 1000)
    } catch {
      setError('service-unavailable')
    } finally {
      submissionRef.current = false
      setIsSubmitting(false)
    }
  }, [resendSecondsRemaining, verificationEmail])

  const signOut = useCallback(async (): Promise<void> => {
    const client = clientRef.current
    if (!client || submissionRef.current) return

    submissionRef.current = true
    setIsSubmitting(true)
    let remoteRevocationConfirmed = false

    try {
      const { error: signOutError } = await client.auth.signOut({ scope: 'local' })
      remoteRevocationConfirmed = signOutError === null
    } catch {
      remoteRevocationConfirmed = false
    } finally {
      // Local access ends now even when the Desktop could not confirm remote revocation.
      await clearPersistedSession().catch(() => undefined)
      setError(undefined)
      setNotice(remoteRevocationConfirmed ? undefined : 'remote-sign-out-delayed')
      setPersistenceUnavailable(false)
      setStatus('unauthenticated')
      setFlow('login')
      resetSignUpVerification()
      submissionRef.current = false
      signOutInProgressRef.current = false
      setIsSubmitting(false)
    }
  }, [resetSignUpVerification])

  return {
    status,
    flow,
    error,
    notice,
    isSubmitting,
    isSessionPersistenceUnavailable: persistenceUnavailable,
    resendSecondsRemaining,
    resendGeneration,
    didResend,
    showLogin,
    showSignUp,
    retryRestore: restore,
    signIn,
    signUp,
    verifySignUp,
    resendSignUp,
    signOut
  }
}

function replaceAuthenticationClient(
  clientRef: React.RefObject<SupabaseClient | null>,
  subscriptionRef: React.RefObject<{ unsubscribe: () => void } | null>,
  config: SupabasePublicConfig,
  onSignedOut: () => void
): SupabaseClient {
  void clientRef.current?.auth.stopAutoRefresh()
  subscriptionRef.current?.unsubscribe()
  const client = createAuthenticationClient(config)
  const {
    data: { subscription }
  } = client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') onSignedOut()
  })
  clientRef.current = client
  subscriptionRef.current = subscription
  return client
}

/**
 * Only a Session the provider has actually rejected may destroy local credentials; every other
 * outcome, including an unclassified one, stays retryable so a temporary failure is never a logout.
 */
function isTerminalRestoreFailure(error: AuthError | null): boolean {
  if (!error) return true
  if (error.name === 'AuthSessionMissingError') return true

  return (
    error instanceof AuthApiError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429
  )
}

function isRateLimited(error: unknown): boolean {
  return (
    error instanceof AuthApiError &&
    (error.status === 429 || (error.code !== undefined && RATE_LIMIT_CODES.has(error.code)))
  )
}
