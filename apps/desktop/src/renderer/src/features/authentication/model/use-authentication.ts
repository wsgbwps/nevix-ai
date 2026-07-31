import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthApiError, type AuthError, type SupabaseClient } from '@supabase/supabase-js'
import { createAuthenticationClient, createRecoveryClient } from '../api/client'
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

export type AuthenticationFlow =
  | 'login'
  | 'signup'
  | 'signup-verification'
  | 'recovery-request'
  | 'recovery-verification'
  | 'recovery-new-password'

export type AuthenticationError =
  | 'invalid-credentials'
  | 'invalid-verification-code'
  | 'same-password'
  | 'rate-limited'
  | 'service-unavailable'

export type AuthenticationNotice =
  | 'session-expired'
  | 'remote-sign-out-delayed'
  | 'password-updated'
  | 'password-updated-revocation-delayed'

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
  readonly showRecovery: () => void
  readonly retryRestore: () => Promise<void>
  readonly signIn: (email: string, password: string) => Promise<void>
  readonly signUp: (email: string, password: string) => Promise<void>
  readonly verifySignUp: (code: string) => Promise<void>
  readonly resendSignUp: () => Promise<void>
  readonly requestRecovery: (email: string) => Promise<void>
  readonly verifyRecovery: (code: string) => Promise<void>
  readonly completeRecovery: (newPassword: string) => Promise<void>
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
  // The recovery subflow keeps its isolated client and email out of React state so the temporary
  // recovery Session can never leak into a render or the top-level authenticated gate.
  const recoveryClientRef = useRef<SupabaseClient | null>(null)
  const recoveryEmailRef = useRef<string | undefined>(undefined)

  const discardRecovery = useCallback((): void => {
    recoveryClientRef.current = null
    recoveryEmailRef.current = undefined
  }, [])

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
        discardRecovery()
      })
  }, [discardRecovery, resetSignUpVerification])

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
    discardRecovery()
  }, [discardRecovery, resetSignUpVerification])

  const showSignUp = useCallback((): void => {
    setFlow('signup')
    setError(undefined)
    setNotice(undefined)
    resetSignUpVerification()
    discardRecovery()
  }, [discardRecovery, resetSignUpVerification])

  const showRecovery = useCallback((): void => {
    setFlow('recovery-request')
    setError(undefined)
    setNotice(undefined)
    resetSignUpVerification()
    discardRecovery()
  }, [discardRecovery, resetSignUpVerification])

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

  const requestRecovery = useCallback(async (email: string): Promise<void> => {
    if (submissionRef.current) return
    const publicConfig = readSupabasePublicConfig()
    if (!publicConfig) return

    submissionRef.current = true
    setIsSubmitting(true)
    setError(undefined)

    try {
      const client = createRecoveryClient(publicConfig)
      const { error: recoveryError } = await client.auth.resetPasswordForEmail(email)

      if (recoveryError) {
        setError(isRateLimited(recoveryError) ? 'rate-limited' : 'service-unavailable')
        return
      }

      // Success is existence-neutral: the same code state appears whether or not the email exists.
      recoveryClientRef.current = client
      recoveryEmailRef.current = email
      setFlow('recovery-verification')
    } catch {
      setError('service-unavailable')
    } finally {
      submissionRef.current = false
      setIsSubmitting(false)
    }
  }, [])

  const verifyRecovery = useCallback(async (code: string): Promise<void> => {
    const client = recoveryClientRef.current
    const email = recoveryEmailRef.current
    if (!client || !email || submissionRef.current || !/^\d{6}$/.test(code)) return

    submissionRef.current = true
    setIsSubmitting(true)
    setError(undefined)

    try {
      const { data, error: verificationError } = await client.auth.verifyOtp({
        email,
        token: code,
        type: 'recovery'
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

      // The recovery Session stays inside the isolated client; only the flow state advances.
      setFlow('recovery-new-password')
    } catch {
      setError('service-unavailable')
    } finally {
      submissionRef.current = false
      setIsSubmitting(false)
    }
  }, [])

  const completeRecovery = useCallback(
    async (newPassword: string): Promise<void> => {
      const client = recoveryClientRef.current
      if (!client || submissionRef.current || !isPasswordByteLengthValid(newPassword)) return

      submissionRef.current = true
      setIsSubmitting(true)
      setError(undefined)

      try {
        const { error: updateError } = await client.auth.updateUser({ password: newPassword })

        if (updateError) {
          if (updateError instanceof AuthApiError && updateError.code === 'same_password') {
            setError('same-password')
          } else {
            setError(isRateLimited(updateError) ? 'rate-limited' : 'service-unavailable')
          }
          return
        }

        let remoteRevocationConfirmed = false
        try {
          const { error: revocationError } = await client.auth.signOut({ scope: 'global' })
          remoteRevocationConfirmed = revocationError === null
        } catch {
          remoteRevocationConfirmed = false
        }

        // Whatever the revocation outcome, the recovery Session is discarded and never promoted;
        // the user always returns to login and signs in with the new password.
        discardRecovery()
        setNotice(
          remoteRevocationConfirmed ? 'password-updated' : 'password-updated-revocation-delayed'
        )
        setFlow('login')
      } catch {
        setError('service-unavailable')
      } finally {
        submissionRef.current = false
        setIsSubmitting(false)
      }
    },
    [discardRecovery]
  )

  const signOut = useCallback(async (): Promise<void> => {
    const client = clientRef.current
    if (!client || submissionRef.current) return

    submissionRef.current = true
    // Suppresses the provider's own SIGNED_OUT emission so this deliberate sign-out cannot race
    // handleProviderSignedOut into a misleading session-expired notice.
    signOutInProgressRef.current = true
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
      discardRecovery()
      submissionRef.current = false
      signOutInProgressRef.current = false
      setIsSubmitting(false)
    }
  }, [discardRecovery, resetSignUpVerification])

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
    showRecovery,
    retryRestore: restore,
    signIn,
    signUp,
    verifySignUp,
    resendSignUp,
    requestRecovery,
    verifyRecovery,
    completeRecovery,
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
