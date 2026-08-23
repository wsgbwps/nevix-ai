import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createJoinCode as createJoinCodeRequest,
  listJoinCodes,
  revokeJoinCode as revokeJoinCodeRequest,
  type AuthenticatedManagementSession,
  type JoinCode,
  type ManagementApiFailure,
  type ManagementApiResult
} from '../api/client'

export type JoinCodesLoadState = 'loading' | 'ready' | 'failed'

/** One join-code command's observable success, rendered as a status line. */
export type JoinCodeNotice =
  | { readonly kind: 'join-code-created'; readonly code: string }
  | { readonly kind: 'join-code-revoked' }

type GetSession = () => Promise<AuthenticatedManagementSession | undefined>

interface JoinCodesState {
  readonly loadState: JoinCodesLoadState
  /** The active codes, newest first; the plaintext is the point of the list. */
  readonly joinCodes: readonly JoinCode[]
  readonly refresh: () => void
  readonly retry: () => void
  readonly commandPending: boolean
  readonly commandFailure: ManagementApiFailure | undefined
  readonly notice: JoinCodeNotice | undefined
  readonly clearNotice: () => void
  readonly createJoinCode: (label: string | undefined) => Promise<boolean>
  readonly revokeJoinCode: (joinCode: JoinCode) => Promise<boolean>
}

/**
 * The Admin's join-code governance loop: the active-code list plus the two
 * commands (issue, revoke). Every outcome is observed, never assumed:
 * success refreshes the list, failure surfaces verbatim for message mapping.
 */
export function useJoinCodes(getSession: GetSession, serverUrl: string): JoinCodesState {
  const [joinCodes, setJoinCodes] = useState<readonly JoinCode[]>([])
  const [loadState, setLoadState] = useState<JoinCodesLoadState>('loading')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [commandPending, setCommandPending] = useState(false)
  const [commandFailure, setCommandFailure] = useState<ManagementApiFailure>()
  const [notice, setNotice] = useState<JoinCodeNotice>()
  const commandPendingRef = useRef(false)

  useEffect(() => {
    let isMounted = true

    void (async () => {
      const session = await getSession()
      if (!session) {
        if (isMounted) setLoadState('failed')
        return
      }

      const result = await listJoinCodes(session, serverUrl)
      if (!isMounted) return

      if (result.outcome !== 'succeeded') {
        setLoadState('failed')
        return
      }

      setJoinCodes(result.value)
      setLoadState('ready')
    })()

    return () => {
      isMounted = false
    }
  }, [getSession, loadAttempt, serverUrl])

  const refresh = useCallback((): void => {
    setLoadAttempt((attempt) => attempt + 1)
  }, [])

  const runCommand = useCallback(
    async <T>(
      run: (session: AuthenticatedManagementSession) => Promise<ManagementApiResult<T>>,
      toNotice: (value: T) => JoinCodeNotice
    ): Promise<boolean> => {
      if (commandPendingRef.current) return false
      commandPendingRef.current = true
      setCommandPending(true)
      setCommandFailure(undefined)
      setNotice(undefined)

      try {
        const session = await getSession()
        if (!session) {
          setCommandFailure({ outcome: 'unauthorized' })
          return false
        }

        const result = await run(session)
        if (result.outcome !== 'succeeded') {
          setCommandFailure(result)
          return false
        }

        setNotice(toNotice(result.value))
        refresh()
        return true
      } finally {
        commandPendingRef.current = false
        setCommandPending(false)
      }
    },
    [getSession, refresh]
  )

  const createJoinCode = useCallback(
    (label: string | undefined): Promise<boolean> =>
      runCommand(
        (session) => createJoinCodeRequest(session, serverUrl, { label }),
        (joinCode) => ({ kind: 'join-code-created', code: joinCode.code })
      ),
    [runCommand, serverUrl]
  )

  const revokeJoinCode = useCallback(
    (joinCode: JoinCode): Promise<boolean> =>
      runCommand(
        (session) => revokeJoinCodeRequest(session, serverUrl, joinCode.id),
        () => ({ kind: 'join-code-revoked' })
      ),
    [runCommand, serverUrl]
  )

  return {
    loadState,
    joinCodes,
    refresh,
    retry: refresh,
    commandPending,
    commandFailure,
    notice,
    clearNotice: useCallback((): void => setNotice(undefined), []),
    createJoinCode,
    revokeJoinCode
  }
}
