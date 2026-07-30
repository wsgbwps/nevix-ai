import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthApiError, type SupabaseClient } from '@supabase/supabase-js'
import { createAuthenticationClient } from '../api/client'
import { readSupabasePublicConfig } from '../api/environment'
import { isPasswordByteLengthValid } from '../policy/password'

export type AuthenticationStatus =
  | 'restoring'
  | 'configuration-error'
  | 'unauthenticated'
  | 'authenticated'

export type AuthenticationFlow = 'login' | 'signup' | 'signup-verification'

export type AuthenticationError =
  | 'invalid-credentials'
  | 'invalid-verification-code'
  | 'rate-limited'
  | 'service-unavailable'

interface Authentication {
  readonly status: AuthenticationStatus
  readonly flow: AuthenticationFlow
  readonly error: AuthenticationError | undefined
  readonly isSubmitting: boolean
  readonly resendSecondsRemaining: number
  readonly resendGeneration: number
  readonly didResend: boolean
  readonly showLogin: () => void
  readonly showSignUp: () => void
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
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [verificationEmail, setVerificationEmail] = useState<string>()
  const [resendAvailableAt, setResendAvailableAt] = useState<number>()
  const [resendSecondsRemaining, setResendSecondsRemaining] = useState(0)
  const [resendGeneration, setResendGeneration] = useState(0)
  const [didResend, setDidResend] = useState(false)
  const clientRef = useRef<SupabaseClient | null>(null)
  const submissionRef = useRef(false)

  useEffect(() => {
    let isCurrent = true
    let transitionTimer: ReturnType<typeof setTimeout> | undefined
    const transitionAfterInitialPaint = (nextStatus: AuthenticationStatus): void => {
      transitionTimer = setTimeout(() => {
        if (isCurrent) setStatus(nextStatus)
      }, MINIMUM_INITIALIZATION_DISPLAY_MS)
    }
    const publicConfig = readSupabasePublicConfig()

    if (!publicConfig) {
      transitionAfterInitialPaint('configuration-error')
      return () => {
        isCurrent = false
        clearTimeout(transitionTimer)
      }
    }

    const client = createAuthenticationClient(publicConfig)
    clientRef.current = client
    void client.auth.getSession().then(() => {
      transitionAfterInitialPaint('unauthenticated')
    })

    return () => {
      isCurrent = false
      clearTimeout(transitionTimer)
    }
  }, [])

  useEffect(() => {
    if (resendAvailableAt === undefined) return

    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((resendAvailableAt - Date.now()) / 1000))
      setResendSecondsRemaining(remaining)
      if (remaining === 0) clearInterval(interval)
    }, 250)
    return () => clearInterval(interval)
  }, [resendAvailableAt])

  const resetSignUpVerification = useCallback((): void => {
    setVerificationEmail(undefined)
    setDidResend(false)
    setResendAvailableAt(undefined)
    setResendSecondsRemaining(0)
  }, [])

  const showLogin = useCallback((): void => {
    setFlow('login')
    setError(undefined)
    resetSignUpVerification()
  }, [resetSignUpVerification])

  const showSignUp = useCallback((): void => {
    setFlow('signup')
    setError(undefined)
    resetSignUpVerification()
  }, [resetSignUpVerification])

  const signIn = useCallback(async (email: string, password: string): Promise<void> => {
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

      setStatus('authenticated')
    } catch {
      setError('service-unavailable')
    } finally {
      submissionRef.current = false
      setIsSubmitting(false)
    }
  }, [])

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

        setStatus('authenticated')
        setFlow('login')
        resetSignUpVerification()
      } catch {
        setError('service-unavailable')
      } finally {
        submissionRef.current = false
        setIsSubmitting(false)
      }
    },
    [resetSignUpVerification, verificationEmail]
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
    try {
      await client.auth.signOut({ scope: 'local' })
    } finally {
      setError(undefined)
      setStatus('unauthenticated')
      setFlow('login')
      resetSignUpVerification()
      submissionRef.current = false
      setIsSubmitting(false)
    }
  }, [resetSignUpVerification])

  return {
    status,
    flow,
    error,
    isSubmitting,
    resendSecondsRemaining,
    resendGeneration,
    didResend,
    showLogin,
    showSignUp,
    signIn,
    signUp,
    verifySignUp,
    resendSignUp,
    signOut
  }
}

function isRateLimited(error: unknown): boolean {
  return (
    error instanceof AuthApiError &&
    (error.status === 429 || (error.code !== undefined && RATE_LIMIT_CODES.has(error.code)))
  )
}
