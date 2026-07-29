import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthApiError, type SupabaseClient } from '@supabase/supabase-js'
import { createAuthenticationClient } from '../api/client'
import { readSupabasePublicConfig } from '../api/environment'

export type AuthenticationStatus =
  | 'restoring'
  | 'configuration-error'
  | 'unauthenticated'
  | 'authenticated'

export type AuthenticationError = 'invalid-credentials' | 'service-unavailable'

interface Authentication {
  readonly status: AuthenticationStatus
  readonly error: AuthenticationError | undefined
  readonly isSubmitting: boolean
  readonly signIn: (email: string, password: string) => Promise<void>
  readonly signOut: () => Promise<void>
}

const INVALID_CREDENTIAL_CODES = new Set([
  'email_not_confirmed',
  'invalid_credentials',
  'user_not_found'
])
const MINIMUM_INITIALIZATION_DISPLAY_MS = 500

export function useAuthentication(): Authentication {
  const [status, setStatus] = useState<AuthenticationStatus>('restoring')
  const [error, setError] = useState<AuthenticationError>()
  const [isSubmitting, setIsSubmitting] = useState(false)
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
      submissionRef.current = false
      setIsSubmitting(false)
    }
  }, [])

  return { status, error, isSubmitting, signIn, signOut }
}
