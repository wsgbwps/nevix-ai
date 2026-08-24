import { useCallback, useEffect, useRef, useState } from 'react'
import type { GoAuthentication, SessionCredentials, UserAccount } from '../api/go-authentication'
import { createGoAuthenticationOverHttp } from '../api/go-authentication-http'
import { createRememberedEmailPersistenceOverIpc } from '../api/remembered-email'
import type { RememberedEmailPersistence } from '../api/remembered-email-persistence'
import { isPasswordByteLengthValid } from '../policy/password'
import { createSessionPersistenceOverIpc } from '../session/persisted-session'
import type { SessionPersistence } from '../session/session-persistence'

export type AuthenticationStatus =
  | 'restoring'
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
  | 'invalid-join-code'
  | 'email-taken'
  | 'invalid-setup-code'
  | 'instance-already-initialized'
  | 'rate-limited'
  | 'service-unavailable'

export type AuthenticationNotice = 'session-expired' | 'remote-sign-out-delayed'

/**
 * The instance's first-run state as the public setup probe answers it.
 * 'probe-failed' means the server could not be asked: the boundary shows a
 * retryable error instead of the login form, because an unreachable verdict
 * must never fall back to a login that may be doomed on an empty instance.
 */
export type InstanceSetupState = 'unknown' | 'uninitialized' | 'initialized' | 'probe-failed'

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
  /** Whether the instance still awaits its first administrator; 'uninitialized' swaps the login boundary for the first-admin wizard. */
  readonly instanceSetup: InstanceSetupState
  /** Whether the awaiting claim demands a setup code (protected deployment); drives the wizard's setup-code field. */
  readonly setupCodeRequired: boolean
  readonly rememberedEmail: string | undefined
  readonly rememberEmailSelected: boolean
  readonly isRememberedEmailPersistenceUnavailable: boolean
  readonly rememberedEmailPersistenceNoticeSurface: 'login' | 'authenticated' | undefined
  readonly userEmail: string | undefined
  /** The session user's stable id; governance surfaces mark the current account with it. */
  readonly userId: string | undefined
  /** The session user's role; Admin-only surfaces key on it while the session stays authoritative. */
  readonly userRole: UserAccount['role'] | undefined
  readonly getSession: () => Promise<AuthenticatedSession | undefined>
  readonly setRememberEmailSelected: (selected: boolean) => void
  readonly consumeRememberedEmailPersistenceNotice: () => void
  readonly dismissError: () => void
  readonly retryRestore: () => Promise<void>
  readonly signIn: (email: string, password: string) => Promise<void>
  readonly register: (
    email: string,
    password: string,
    joinCode: string,
    displayName: string
  ) => Promise<void>
  readonly initialize: (
    email: string,
    password: string,
    setupCode: string | undefined,
    displayName: string
  ) => Promise<void>
  readonly retrySetupProbe: () => void
  readonly completePasswordChange: (currentPassword: string, newPassword: string) => Promise<void>
  readonly signOut: () => Promise<void>
}

const MINIMUM_INITIALIZATION_DISPLAY_MS = 500

export function useAuthentication(serverUrl: string | undefined): Authentication {
  const [status, setStatus] = useState<AuthenticationStatus>('restoring')
  const [error, setError] = useState<AuthenticationError>()
  const [notice, setNotice] = useState<AuthenticationNotice>()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [persistenceUnavailable, setPersistenceUnavailable] = useState(false)
  const [instanceSetup, setInstanceSetup] = useState<InstanceSetupState>('unknown')
  const [setupCodeRequired, setSetupCodeRequired] = useState(false)
  const [rememberedEmail, setRememberedEmail] = useState<string>()
  const [rememberEmailSelected, setRememberEmailSelectedState] = useState(true)
  const [rememberedEmailPersistenceUnavailable, setRememberedEmailPersistenceUnavailable] =
    useState(false)
  const [rememberedEmailPersistenceNoticeSurface, setRememberedEmailPersistenceNoticeSurface] =
    useState<'login' | 'authenticated'>()
  const [userEmail, setUserEmail] = useState<string | undefined>()
  const [userId, setUserId] = useState<string | undefined>()
  const [userRole, setUserRole] = useState<UserAccount['role'] | undefined>()
  const goAuthenticationRef = useRef<GoAuthentication | null>(null)
  const sessionPersistenceRef = useRef<SessionPersistence | undefined>(undefined)
  const rememberedEmailPersistenceRef = useRef<RememberedEmailPersistence | undefined>(undefined)
  const credentialsRef = useRef<SessionCredentials | undefined>(undefined)
  const submissionRef = useRef(false)
  const statusRef = useRef<AuthenticationStatus>('restoring')
  const rememberEmailSelectedRef = useRef(true)
  const rememberEmailSelectionGenerationRef = useRef(0)
  const rememberedEmailMutationRef = useRef<Promise<void>>(Promise.resolve())
  const hasShownRememberedEmailPersistenceNoticeRef = useRef(false)
  const hasInitializedRef = useRef(false)
  const restoreInProgressRef = useRef(false)
  const setupProbeGenerationRef = useRef(0)
  const sessionPersistenceDegradedRef = useRef(false)
  if (sessionPersistenceRef.current === undefined) {
    sessionPersistenceRef.current = createSessionPersistenceOverIpc()
  }
  if (rememberedEmailPersistenceRef.current === undefined) {
    rememberedEmailPersistenceRef.current = createRememberedEmailPersistenceOverIpc()
  }
  // Both persistence adapters are created once per runtime and never replaced; the
  // consts keep every callback free of null-handling for a lifetime invariant.
  const sessionPersistence = sessionPersistenceRef.current
  const rememberedEmailPersistence = rememberedEmailPersistenceRef.current

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

  const clearError = useCallback((): void => {
    setError(undefined)
  }, [])

  const retireRememberedEmailPersistenceNotice = useCallback((): void => {
    if (!hasShownRememberedEmailPersistenceNoticeRef.current) return
    setRememberedEmailPersistenceNoticeSurface(undefined)
  }, [])

  /** Refreshes the instance's first-run state whenever the sign-in boundary settles onto the screen. */
  const probeSetupStatus = useCallback((): void => {
    const goAuthentication = goAuthenticationRef.current
    if (!goAuthentication) return
    const generation = ++setupProbeGenerationRef.current
    void goAuthentication.probeSetup().then((probe) => {
      // A probe from an earlier server URL never overwrites the boundary's state.
      if (generation !== setupProbeGenerationRef.current) return
      if (probe.outcome !== 'succeeded') {
        // The state is unknowable: a retryable error, never a fallback to a
        // login that cannot succeed on an empty instance.
        setInstanceSetup('probe-failed')
        return
      }
      setSetupCodeRequired(probe.setupCodeRequired)
      setInstanceSetup(probe.initialized ? 'initialized' : 'uninitialized')
    })
  }, [])

  const settleUnauthenticated = useCallback(
    (nextNotice: AuthenticationNotice | undefined): void => {
      credentialsRef.current = undefined
      retireRememberedEmailPersistenceNotice()
      setError(undefined)
      setNotice(nextNotice)
      setPersistenceUnavailable(false)
      setUserEmail(undefined)
      setUserId(undefined)
      setUserRole(undefined)
      rememberEmailSelectedRef.current = true
      rememberEmailSelectionGenerationRef.current += 1
      setRememberEmailSelectedState(true)
      statusRef.current = 'unauthenticated'
      setStatus('unauthenticated')
      probeSetupStatus()
    },
    [probeSetupStatus, retireRememberedEmailPersistenceNotice]
  )

  /** Ends a session the server has rejected: local credentials die, the login screen explains why. */
  const abandonRejectedSession = useCallback(
    (nextNotice: AuthenticationNotice): void => {
      void sessionPersistence
        .clear()
        .catch(() => undefined)
        .finally(() => settleUnauthenticated(nextNotice))
    },
    [sessionPersistence, settleUnauthenticated]
  )

  const settleSession = useCallback(
    (credentials: SessionCredentials): void => {
      credentialsRef.current = credentials
      retireRememberedEmailPersistenceNotice()
      setPersistenceUnavailable(sessionPersistenceDegradedRef.current)
      setNotice(undefined)
      setUserEmail(credentials.user.email)
      setUserId(credentials.user.id)
      setUserRole(credentials.user.role)
      const nextStatus: AuthenticationStatus = credentials.user.mustChangePassword
        ? 'password-change-required'
        : 'authenticated'
      statusRef.current = nextStatus
      setStatus(nextStatus)
    },
    [retireRememberedEmailPersistenceNotice]
  )

  /** Keeps the encrypted slot for the next launch; its outcome decides whether the shell must warn about persistence degradation. */
  const persistSession = useCallback(
    async (credentials: SessionCredentials): Promise<void> => {
      const replacement = await sessionPersistence.replace(credentials)
      sessionPersistenceDegradedRef.current = replacement.outcome !== 'persisted'
    },
    [sessionPersistence]
  )

  const getSession = useCallback(async (): Promise<AuthenticatedSession | undefined> => {
    if (statusRef.current !== 'authenticated') return undefined
    const credentials = credentialsRef.current
    if (!credentials) return undefined

    return { token: credentials.token, user: credentials.user }
  }, [])

  const restore = useCallback(async (): Promise<void> => {
    if (restoreInProgressRef.current) return
    if (serverUrl === undefined) return
    restoreInProgressRef.current = true

    statusRef.current = 'restoring'
    setStatus('restoring')
    setError(undefined)

    try {
      goAuthenticationRef.current = createGoAuthenticationOverHttp(serverUrl)
      // A boundary for a new server starts from the unknown setup state until
      // its own probe answers; a stale wizard from the previous server must
      // not survive the switch.
      setupProbeGenerationRef.current += 1
      setInstanceSetup('unknown')
      setSetupCodeRequired(false)
      sessionPersistenceDegradedRef.current = false

      const [stored, remembered] = await Promise.all([
        sessionPersistence.read(),
        rememberedEmailPersistence.read()
      ])
      setRememberedEmail(remembered.outcome === 'remembered' ? remembered.email : undefined)
      if (
        remembered.outcome === 'unavailable' ||
        (remembered.outcome === 'remembered' && remembered.persistence === 'memory-only')
      ) {
        reportRememberedEmailPersistenceUnavailable('login')
      } else {
        reportRememberedEmailPersistenceAvailable()
      }

      // The envelope may still hold a valid token, so nothing is deleted; the retry boundary
      // re-reads the store once the secure-storage backend recovers.
      if (stored.outcome === 'unavailable') {
        statusRef.current = 'restore-failure'
        setStatus('restore-failure')
        return
      }

      if (stored.outcome === 'unreadable') {
        await sessionPersistence.clear().catch(() => undefined)
        settleUnauthenticated('session-expired')
        return
      }

      if (stored.outcome === 'empty') {
        settleUnauthenticated(undefined)
        return
      }

      const validation = await goAuthenticationRef.current.validateSession(stored.credentials.token)
      if (validation.outcome === 'succeeded') {
        // Validation is the authority for account facts: display name, role, and any password
        // change the server started demanding since the session was stored.
        settleSession({
          token: stored.credentials.token,
          expiresAt: stored.credentials.expiresAt,
          user: validation.user
        })
        return
      }

      if (validation.outcome === 'session-rejected') {
        abandonRejectedSession('session-expired')
        return
      }

      // An unreachable or broken server keeps the restore retryable: a temporary
      // outage is never a logout.
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
    rememberedEmailPersistence,
    reportRememberedEmailPersistenceAvailable,
    reportRememberedEmailPersistenceUnavailable,
    serverUrl,
    sessionPersistence,
    settleSession,
    settleUnauthenticated
  ])

  useEffect(() => {
    if (serverUrl === undefined) return
    if (hasInitializedRef.current) {
      void restore()
      return
    }
    hasInitializedRef.current = true

    // The restoring boundary stays visible long enough that no launch flashes another boundary.
    const initialized = new Promise<void>((resolve) => {
      setTimeout(resolve, MINIMUM_INITIALIZATION_DISPLAY_MS)
    })
    void initialized.then(() => restore())
  }, [restore, serverUrl])

  const setRememberEmailSelected = useCallback(
    (selected: boolean): void => {
      rememberEmailSelectedRef.current = selected
      const selectionGeneration = ++rememberEmailSelectionGenerationRef.current
      setRememberEmailSelectedState(selected)
      if (selected) return

      const previousRememberedEmail = rememberedEmail
      setRememberedEmail(undefined)
      void enqueueRememberedEmailMutation(() => rememberedEmailPersistence.clear())
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
      rememberedEmailPersistence,
      reportRememberedEmailPersistenceAvailable,
      reportRememberedEmailPersistenceUnavailable
    ]
  )

  const rememberLoginEmail = useCallback(
    (email: string): void => {
      setRememberedEmail(email)
      void enqueueRememberedEmailMutation(() => rememberedEmailPersistence.replace(email))
        .then((result) => {
          if (result.outcome === 'memory-only' || result.outcome === 'replace-failed') {
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
      rememberedEmailPersistence,
      reportRememberedEmailPersistenceAvailable,
      reportRememberedEmailPersistenceUnavailable
    ]
  )

  const signIn = useCallback(
    async (email: string, password: string): Promise<void> => {
      const goAuthentication = goAuthenticationRef.current
      if (!goAuthentication || submissionRef.current) return

      submissionRef.current = true
      setIsSubmitting(true)
      setError(undefined)

      try {
        const login = await goAuthentication.signIn(email, password)
        if (login.outcome !== 'succeeded') {
          setError(
            login.outcome === 'invalid-credentials' ||
              login.outcome === 'account-disabled' ||
              login.outcome === 'rate-limited'
              ? login.outcome
              : 'service-unavailable'
          )
          return
        }

        // The encrypted slot is written before the shell opens, so a crash right after
        // login still restores this session on the next launch.
        await persistSession(login.session)
        if (rememberEmailSelectedRef.current && login.session.user.email) {
          rememberLoginEmail(login.session.user.email)
        }
        settleSession(login.session)
      } catch {
        setError('service-unavailable')
      } finally {
        submissionRef.current = false
        setIsSubmitting(false)
      }
    },
    [persistSession, rememberLoginEmail, settleSession]
  )

  const register = useCallback(
    async (
      email: string,
      password: string,
      joinCode: string,
      displayName: string
    ): Promise<void> => {
      const goAuthentication = goAuthenticationRef.current
      if (!goAuthentication || submissionRef.current) return

      submissionRef.current = true
      setIsSubmitting(true)
      setError(undefined)

      try {
        const registration = await goAuthentication.register(email, password, joinCode, displayName)
        if (registration.outcome !== 'succeeded') {
          setError(
            registration.outcome === 'invalid-join-code' ||
              registration.outcome === 'email-taken' ||
              registration.outcome === 'rate-limited'
              ? registration.outcome
              : registration.outcome === 'new-password-too-short'
                ? 'password-too-short'
                : registration.outcome === 'new-password-over-limit'
                  ? 'invalid-password'
                  : 'service-unavailable'
          )
          return
        }

        // A registered member already owns their password, so the new session settles
        // straight into the shell; the encrypted slot is written before it opens.
        await persistSession(registration.session)
        settleSession(registration.session)
      } catch {
        setError('service-unavailable')
      } finally {
        submissionRef.current = false
        setIsSubmitting(false)
      }
    },
    [persistSession, settleSession]
  )

  const initialize = useCallback(
    async (
      email: string,
      password: string,
      setupCode: string | undefined,
      displayName: string
    ): Promise<void> => {
      const goAuthentication = goAuthenticationRef.current
      if (!goAuthentication || submissionRef.current) return

      submissionRef.current = true
      setIsSubmitting(true)
      setError(undefined)

      try {
        const claim = await goAuthentication.claimInstance(email, password, setupCode, displayName)
        if (claim.outcome !== 'succeeded') {
          if (claim.outcome === 'already-claimed') {
            // Another request won the first-admin race: the wizard is over and
            // the sign-in boundary explains what happened.
            setInstanceSetup('initialized')
            setError('instance-already-initialized')
            return
          }
          setError(
            claim.outcome === 'invalid-setup-code' || claim.outcome === 'rate-limited'
              ? claim.outcome
              : claim.outcome === 'new-password-too-short'
                ? 'password-too-short'
                : claim.outcome === 'new-password-over-limit'
                  ? 'invalid-password'
                  : 'service-unavailable'
          )
          return
        }

        // The first administrator owns the chosen password from the first
        // moment, so the new session settles straight into the shell; the
        // encrypted slot is written before it opens. The instance is now
        // initialized for every later boundary on this device too — the
        // wizard never renders again, whatever a later status probe answers.
        setInstanceSetup('initialized')
        await persistSession(claim.session)
        settleSession(claim.session)
      } catch {
        setError('service-unavailable')
      } finally {
        submissionRef.current = false
        setIsSubmitting(false)
      }
    },
    [persistSession, settleSession]
  )

  const completePasswordChange = useCallback(
    async (currentPassword: string, newPassword: string): Promise<void> => {
      const goAuthentication = goAuthenticationRef.current
      const credentials = credentialsRef.current
      if (!goAuthentication || !credentials || submissionRef.current) return
      if (!isPasswordByteLengthValid(newPassword)) return

      submissionRef.current = true
      setIsSubmitting(true)
      setError(undefined)

      try {
        const change = await goAuthentication.changePassword(
          credentials.token,
          currentPassword,
          newPassword
        )
        if (change.outcome !== 'succeeded') {
          if (change.outcome === 'session-rejected') {
            abandonRejectedSession('session-expired')
            return
          }
          setError(
            change.outcome === 'invalid-current-password'
              ? 'invalid-credentials'
              : change.outcome === 'new-password-rejected'
                ? 'invalid-password'
                : change.outcome === 'rate-limited'
                  ? 'rate-limited'
                  : 'service-unavailable'
          )
          return
        }

        // The server keeps this session alive while revoking every other device.
        const changed: SessionCredentials = {
          token: credentials.token,
          expiresAt: credentials.expiresAt,
          user: { ...credentials.user, mustChangePassword: false }
        }
        await persistSession(changed)
        settleSession(changed)
      } catch {
        setError('service-unavailable')
      } finally {
        submissionRef.current = false
        setIsSubmitting(false)
      }
    },
    [abandonRejectedSession, persistSession, settleSession]
  )

  const signOut = useCallback(async (): Promise<void> => {
    const goAuthentication = goAuthenticationRef.current
    const credentials = credentialsRef.current
    if (!goAuthentication || submissionRef.current) return

    submissionRef.current = true
    setIsSubmitting(true)
    let remoteRevocationConfirmed = false

    try {
      if (credentials) {
        const end = await goAuthentication.endSession(credentials.token)
        remoteRevocationConfirmed = end.outcome === 'revoked'
      } else {
        remoteRevocationConfirmed = true
      }
    } catch {
      remoteRevocationConfirmed = false
    } finally {
      // Local access ends now even when the Desktop could not confirm remote revocation.
      await sessionPersistence.clear().catch(() => undefined)
      settleUnauthenticated(remoteRevocationConfirmed ? undefined : 'remote-sign-out-delayed')
      submissionRef.current = false
      setIsSubmitting(false)
    }
  }, [sessionPersistence, settleUnauthenticated])

  return {
    status,
    error,
    notice,
    isSubmitting,
    isSessionPersistenceUnavailable: persistenceUnavailable,
    instanceSetup,
    setupCodeRequired,
    rememberedEmail,
    rememberEmailSelected,
    isRememberedEmailPersistenceUnavailable: rememberedEmailPersistenceUnavailable,
    rememberedEmailPersistenceNoticeSurface,
    userEmail,
    userId,
    userRole,
    getSession,
    setRememberEmailSelected,
    consumeRememberedEmailPersistenceNotice,
    dismissError: clearError,
    retryRestore: restore,
    retrySetupProbe: probeSetupStatus,
    signIn,
    register,
    initialize,
    completePasswordChange,
    signOut
  }
}
