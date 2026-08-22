import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createIdentityClient,
  type IdentityApiFailure,
  type IdentityClient,
  type SessionCredentials,
  type UserAccount
} from '../api/client'
import {
  clearRememberedEmail,
  readRememberedEmail,
  replaceRememberedEmail
} from '../api/remembered-email'
import { isPasswordByteLengthValid } from '../policy/password'
import { readServerPublicConfig } from '../../../lib/server-public-config'
import {
  clearPersistedSession,
  isSessionPersistenceUnavailable,
  readPersistedCredentials,
  replacePersistedCredentials
} from '../session/persisted-session'

export type AuthenticationStatus =
  | 'restoring'
  | 'configuration-error'
  | 'restore-failure'
  | 'unauthenticated'
  | 'password-change-required'
  | 'authenticated'

export type AuthenticationError =
  | 'invalid-credentials'
  | 'account-disabled'
  | 'invalid-password'
  | 'password-too-short'
  | 'password-too-long'
  | 'rate-limited'
  | 'service-unavailable'

export type AuthenticationNotice = 'session-expired' | 'remote-sign-out-delayed'

/** The session handed to authenticated consumers; the token stays out of URLs and storage except the encrypted slot. */
export interface AuthenticatedSession {
  readonly token: string
  readonly user: UserAccount
}

interface Authentication {
  readonly status: AuthenticationStatus
  readonly error: AuthenticationError | undefined
  readonly notice: AuthenticationNotice | undefined
  readonly isSubmitting: boolean
  readonly isSessionPersistenceUnavailable: boolean
  readonly rememberedEmail: string | undefined
  readonly rememberEmailSelected: boolean
  readonly isRememberedEmailPersistenceUnavailable: boolean
  readonly rememberedEmailPersistenceNoticeSurface: 'login' | 'authenticated' | undefined
  readonly userEmail: string | undefined
  readonly getSession: () => Promise<AuthenticatedSession | undefined>
  readonly setRememberEmailSelected: (selected: boolean) => void
  readonly consumeRememberedEmailPersistenceNotice: () => void
  readonly retryRestore: () => Promise<void>
  readonly signIn: (email: string, password: string) => Promise<void>
  readonly completePasswordChange: (currentPassword: string, newPassword: string) => Promise<void>
  readonly signOut: () => Promise<void>
}

const MINIMUM_INITIALIZATION_DISPLAY_MS = 500

export function useAuthentication(): Authentication {
  const [status, setStatus] = useState<AuthenticationStatus>('restoring')
  const [error, setError] = useState<AuthenticationError>()
  const [notice, setNotice] = useState<AuthenticationNotice>()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [persistenceUnavailable, setPersistenceUnavailable] = useState(false)
  const [rememberedEmail, setRememberedEmail] = useState<string>()
  const [rememberEmailSelected, setRememberEmailSelectedState] = useState(true)
  const [rememberedEmailPersistenceUnavailable, setRememberedEmailPersistenceUnavailable] =
    useState(false)
  const [rememberedEmailPersistenceNoticeSurface, setRememberedEmailPersistenceNoticeSurface] =
    useState<'login' | 'authenticated'>()
  const [userEmail, setUserEmail] = useState<string | undefined>()
  const clientRef = useRef<IdentityClient | null>(null)
  const credentialsRef = useRef<SessionCredentials | undefined>(undefined)
  const submissionRef = useRef(false)
  const statusRef = useRef<AuthenticationStatus>('restoring')
  const rememberEmailSelectedRef = useRef(true)
  const rememberEmailSelectionGenerationRef = useRef(0)
  const rememberedEmailMutationRef = useRef<Promise<void>>(Promise.resolve())
  const hasShownRememberedEmailPersistenceNoticeRef = useRef(false)
  const hasInitializedRef = useRef(false)
  const restoreInProgressRef = useRef(false)

  const enqueueRememberedEmailMutation = useCallback(
    <Result>(mutation: () => Promise<Result>): Promise<Result> => {
      const result = rememberedEmailMutationRef.current.then(mutation)
      rememberedEmailMutationRef.current = result.then(
        () => undefined,
        () => undefined
      )
      return result
    },
    []
  )

  const reportRememberedEmailPersistenceUnavailable = useCallback(
    (target: 'login' | 'authenticated'): void => {
      setRememberedEmailPersistenceUnavailable(true)
      if (hasShownRememberedEmailPersistenceNoticeRef.current) return
      setRememberedEmailPersistenceNoticeSurface((currentSurface) => currentSurface ?? target)
    },
    []
  )

  const reportRememberedEmailPersistenceAvailable = useCallback((): void => {
    setRememberedEmailPersistenceUnavailable(false)
    setRememberedEmailPersistenceNoticeSurface(undefined)
  }, [])

  const consumeRememberedEmailPersistenceNotice = useCallback((): void => {
    if (hasShownRememberedEmailPersistenceNoticeRef.current) return
    hasShownRememberedEmailPersistenceNoticeRef.current = true
  }, [])

  const retireRememberedEmailPersistenceNotice = useCallback((): void => {
    if (!hasShownRememberedEmailPersistenceNoticeRef.current) return
    setRememberedEmailPersistenceNoticeSurface(undefined)
  }, [])

  const settleUnauthenticated = useCallback(
    (nextNotice: AuthenticationNotice | undefined): void => {
      credentialsRef.current = undefined
      retireRememberedEmailPersistenceNotice()
      setError(undefined)
      setNotice(nextNotice)
      setPersistenceUnavailable(false)
      setUserEmail(undefined)
      rememberEmailSelectedRef.current = true
      rememberEmailSelectionGenerationRef.current += 1
      setRememberEmailSelectedState(true)
      statusRef.current = 'unauthenticated'
      setStatus('unauthenticated')
    },
    [retireRememberedEmailPersistenceNotice]
  )

  /** Ends a session the server has rejected: local credentials die, the login screen explains why. */
  const abandonRejectedSession = useCallback(
    (nextNotice: AuthenticationNotice): void => {
      void clearPersistedSession()
        .catch(() => undefined)
        .finally(() => settleUnauthenticated(nextNotice))
    },
    [settleUnauthenticated]
  )

  const settleSession = useCallback(
    (credentials: SessionCredentials): void => {
      credentialsRef.current = credentials
      retireRememberedEmailPersistenceNotice()
      setPersistenceUnavailable(isSessionPersistenceUnavailable())
      setNotice(undefined)
      setUserEmail(credentials.user.email)
      const nextStatus: AuthenticationStatus = credentials.user.mustChangePassword
        ? 'password-change-required'
        : 'authenticated'
      statusRef.current = nextStatus
      setStatus(nextStatus)
    },
    [retireRememberedEmailPersistenceNotice]
  )

  const getSession = useCallback(async (): Promise<AuthenticatedSession | undefined> => {
    if (statusRef.current !== 'authenticated') return undefined
    const credentials = credentialsRef.current
    if (!credentials) return undefined

    return { token: credentials.token, user: credentials.user }
  }, [])

  const restore = useCallback(async (): Promise<void> => {
    if (restoreInProgressRef.current) return
    restoreInProgressRef.current = true

    statusRef.current = 'restoring'
    setStatus('restoring')
    setError(undefined)

    try {
      const config = readServerPublicConfig()
      if (!config) {
        statusRef.current = 'configuration-error'
        setStatus('configuration-error')
        return
      }
      clientRef.current = createIdentityClient(config)

      const [stored, remembered] = await Promise.all([
        readPersistedCredentials(),
        readRememberedEmail().catch(() => ({ outcome: 'storage-unavailable' as const }))
      ])
      setRememberedEmail(remembered.outcome === 'email' ? remembered.email : undefined)
      if (
        remembered.outcome === 'storage-unavailable' ||
        (remembered.outcome === 'email' && remembered.persistence === 'memory-only')
      ) {
        reportRememberedEmailPersistenceUnavailable('login')
      } else {
        reportRememberedEmailPersistenceAvailable()
      }

      // The envelope may still hold a valid token, so nothing is deleted; the retry boundary
      // re-reads the store once the secure-storage backend recovers.
      if (stored.outcome === 'storage-unavailable') {
        statusRef.current = 'restore-failure'
        setStatus('restore-failure')
        return
      }

      if (stored.outcome === 'unreadable') {
        await clearPersistedSession().catch(() => undefined)
        settleUnauthenticated('session-expired')
        return
      }

      if (stored.outcome === 'empty') {
        settleUnauthenticated(undefined)
        return
      }

      const client = clientRef.current
      const me = await client.me(stored.credentials.token)
      if (me.outcome === 'succeeded') {
        // /me is the authority for account facts: display name, role, and any password
        // change the server started demanding since the session was stored.
        settleSession({
          token: stored.credentials.token,
          expiresAt: stored.credentials.expiresAt,
          user: me.value
        })
        return
      }

      if (me.outcome === 'unauthorized') {
        abandonRejectedSession('session-expired')
        return
      }

      // Network and server failures stay retryable: a temporary outage is never a logout.
      statusRef.current = 'restore-failure'
      setStatus('restore-failure')
    } catch {
      statusRef.current = 'restore-failure'
      setStatus('restore-failure')
    } finally {
      restoreInProgressRef.current = false
    }
  }, [
    abandonRejectedSession,
    reportRememberedEmailPersistenceAvailable,
    reportRememberedEmailPersistenceUnavailable,
    settleSession,
    settleUnauthenticated
  ])

  useEffect(() => {
    if (hasInitializedRef.current) return
    hasInitializedRef.current = true

    // The restoring boundary stays visible long enough that no launch flashes another boundary.
    const initialized = new Promise<void>((resolve) => {
      setTimeout(resolve, MINIMUM_INITIALIZATION_DISPLAY_MS)
    })
    void initialized.then(() => restore())
  }, [restore])

  const setRememberEmailSelected = useCallback(
    (selected: boolean): void => {
      rememberEmailSelectedRef.current = selected
      const selectionGeneration = ++rememberEmailSelectionGenerationRef.current
      setRememberEmailSelectedState(selected)
      if (selected) return

      const previousRememberedEmail = rememberedEmail
      setRememberedEmail(undefined)
      void enqueueRememberedEmailMutation(clearRememberedEmail)
        .then((result) => {
          if (
            selectionGeneration !== rememberEmailSelectionGenerationRef.current ||
            rememberEmailSelectedRef.current
          ) {
            return
          }

          if (result.outcome === 'cleared') {
            reportRememberedEmailPersistenceAvailable()
            return
          }

          reportRememberedEmailPersistenceUnavailable(
            statusRef.current === 'authenticated' ? 'authenticated' : 'login'
          )
          setRememberedEmail(previousRememberedEmail)
          rememberEmailSelectedRef.current = true
          setRememberEmailSelectedState(true)
        })
        .catch(() => {
          if (
            selectionGeneration !== rememberEmailSelectionGenerationRef.current ||
            rememberEmailSelectedRef.current
          ) {
            return
          }
          reportRememberedEmailPersistenceUnavailable(
            statusRef.current === 'authenticated' ? 'authenticated' : 'login'
          )
          setRememberedEmail(previousRememberedEmail)
          rememberEmailSelectedRef.current = true
          setRememberEmailSelectedState(true)
        })
    },
    [
      enqueueRememberedEmailMutation,
      rememberedEmail,
      reportRememberedEmailPersistenceAvailable,
      reportRememberedEmailPersistenceUnavailable
    ]
  )

  const rememberLoginEmail = useCallback(
    (email: string): void => {
      setRememberedEmail(email)
      void enqueueRememberedEmailMutation(() => replaceRememberedEmail(email))
        .then((result) => {
          if (result.outcome === 'memory-only') {
            reportRememberedEmailPersistenceUnavailable(
              statusRef.current === 'authenticated' ? 'authenticated' : 'login'
            )
          } else {
            reportRememberedEmailPersistenceAvailable()
          }
        })
        .catch(() =>
          reportRememberedEmailPersistenceUnavailable(
            statusRef.current === 'authenticated' ? 'authenticated' : 'login'
          )
        )
    },
    [
      enqueueRememberedEmailMutation,
      reportRememberedEmailPersistenceAvailable,
      reportRememberedEmailPersistenceUnavailable
    ]
  )

  const signIn = useCallback(
    async (email: string, password: string): Promise<void> => {
      const client = clientRef.current
      if (!client || submissionRef.current) return

      submissionRef.current = true
      setIsSubmitting(true)
      setError(undefined)

      try {
        const login = await client.login(email, password)
        if (login.outcome !== 'succeeded') {
          setError(mapRequestFailure(login))
          return
        }

        // The encrypted slot is written before the shell opens, so a crash right after
        // login still restores this session on the next launch.
        await replacePersistedCredentials(login.value)
        if (rememberEmailSelectedRef.current && login.value.user.email) {
          rememberLoginEmail(login.value.user.email)
        }
        settleSession(login.value)
      } catch {
        setError('service-unavailable')
      } finally {
        submissionRef.current = false
        setIsSubmitting(false)
      }
    },
    [rememberLoginEmail, settleSession]
  )

  const completePasswordChange = useCallback(
    async (currentPassword: string, newPassword: string): Promise<void> => {
      const client = clientRef.current
      const credentials = credentialsRef.current
      if (!client || !credentials || submissionRef.current) return
      if (!isPasswordByteLengthValid(newPassword)) return

      submissionRef.current = true
      setIsSubmitting(true)
      setError(undefined)

      try {
        const change = await client.changePassword(credentials.token, currentPassword, newPassword)
        if (change.outcome !== 'succeeded') {
          if (change.outcome === 'unauthorized') {
            abandonRejectedSession('session-expired')
            return
          }
          setError(mapRequestFailure(change))
          return
        }

        // The server keeps this session alive while revoking every other device.
        const changed: SessionCredentials = {
          token: credentials.token,
          expiresAt: credentials.expiresAt,
          user: { ...credentials.user, mustChangePassword: false }
        }
        await replacePersistedCredentials(changed)
        settleSession(changed)
      } catch {
        setError('service-unavailable')
      } finally {
        submissionRef.current = false
        setIsSubmitting(false)
      }
    },
    [abandonRejectedSession, settleSession]
  )

  const signOut = useCallback(async (): Promise<void> => {
    const client = clientRef.current
    const credentials = credentialsRef.current
    if (!client || submissionRef.current) return

    submissionRef.current = true
    setIsSubmitting(true)
    let remoteRevocationConfirmed = false

    try {
      if (credentials) {
        const logout = await client.logout(credentials.token)
        remoteRevocationConfirmed = logout.outcome === 'succeeded'
      } else {
        remoteRevocationConfirmed = true
      }
    } catch {
      remoteRevocationConfirmed = false
    } finally {
      // Local access ends now even when the Desktop could not confirm remote revocation.
      await clearPersistedSession().catch(() => undefined)
      settleUnauthenticated(remoteRevocationConfirmed ? undefined : 'remote-sign-out-delayed')
      submissionRef.current = false
      setIsSubmitting(false)
    }
  }, [settleUnauthenticated])

  return {
    status,
    error,
    notice,
    isSubmitting,
    isSessionPersistenceUnavailable: persistenceUnavailable,
    rememberedEmail,
    rememberEmailSelected,
    isRememberedEmailPersistenceUnavailable: rememberedEmailPersistenceUnavailable,
    rememberedEmailPersistenceNoticeSurface,
    userEmail,
    getSession,
    setRememberEmailSelected,
    consumeRememberedEmailPersistenceNotice,
    retryRestore: restore,
    signIn,
    completePasswordChange,
    signOut
  }
}

function mapRequestFailure(failure: IdentityApiFailure): AuthenticationError {
  if (failure.outcome === 'rate-limited') return 'rate-limited'
  if (failure.outcome !== 'request-rejected') return 'service-unavailable'

  switch (failure.code) {
    case 'invalid_credentials':
      return 'invalid-credentials'
    case 'account_disabled':
      return 'account-disabled'
    case 'invalid_password':
      return 'invalid-password'
    default:
      return 'service-unavailable'
  }
}
