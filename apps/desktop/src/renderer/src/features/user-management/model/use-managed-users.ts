import { useCallback, useEffect, useRef, useState } from 'react'
import {
  changeUserEmail as changeUserEmailRequest,
  changeUserRole as changeUserRoleRequest,
  createUser as createUserRequest,
  deleteUser as deleteUserRequest,
  disableUser as disableUserRequest,
  listManagedUsers,
  resetUserPassword as resetUserPasswordRequest,
  type AuthenticatedManagementSession,
  type CreateUserInput,
  type ManagedUser,
  type ManagedUsersPage,
  type ManagementApiFailure,
  type ManagementApiResult,
  type UserRole
} from '../api/client'

export const USERS_PER_PAGE = 20
const SEARCH_DEBOUNCE_MS = 300

export type ManagedUsersLoadState = 'loading' | 'ready' | 'failed'

/** One governance command's observable success, rendered as a status line. */
export type GovernanceNotice =
  | { readonly kind: 'user-created'; readonly email: string }
  | { readonly kind: 'user-disabled'; readonly email: string }
  | { readonly kind: 'password-reset'; readonly email: string }
  | { readonly kind: 'email-changed'; readonly email: string }
  | { readonly kind: 'role-changed'; readonly email: string; readonly role: UserRole }
  | { readonly kind: 'user-deleted'; readonly email: string }

type GetSession = () => Promise<AuthenticatedManagementSession | undefined>

interface ManagedUsersState {
  readonly loadState: ManagedUsersLoadState
  /** The page the server returned for the current search and page request. */
  readonly page: ManagedUsersPage | undefined
  readonly totalPages: number
  readonly searchDraft: string
  readonly setSearchDraft: (search: string) => void
  readonly turnToPage: (page: number) => void
  readonly refresh: () => void
  readonly retry: () => void
  readonly commandPending: boolean
  readonly commandFailure: ManagementApiFailure | undefined
  readonly notice: GovernanceNotice | undefined
  readonly clearNotice: () => void
  readonly createUser: (input: CreateUserInput) => Promise<boolean>
  readonly disableUser: (user: ManagedUser) => Promise<boolean>
  readonly resetPassword: (user: ManagedUser, initialPassword: string) => Promise<boolean>
  readonly changeEmail: (user: ManagedUser, email: string) => Promise<boolean>
  readonly changeRole: (user: ManagedUser, role: UserRole) => Promise<boolean>
  readonly deleteUser: (user: ManagedUser) => Promise<boolean>
}

/**
 * The Admin's management list: server-pagination + debounced search over
 * GET /identity/admin/users, and the six governance commands. Every command
 * outcome is observed, never assumed: success refreshes the list, failure is
 * surfaced verbatim for message mapping.
 */
export function useManagedUsers(getSession: GetSession, serverUrl: string): ManagedUsersState {
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [requestedPage, setRequestedPage] = useState(1)
  const [page, setPage] = useState<ManagedUsersPage>()
  const [loadState, setLoadState] = useState<ManagedUsersLoadState>('loading')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [commandPending, setCommandPending] = useState(false)
  const [commandFailure, setCommandFailure] = useState<ManagementApiFailure>()
  const [notice, setNotice] = useState<GovernanceNotice>()
  const commandPendingRef = useRef(false)

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchDraft.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchDraft])

  useEffect(() => {
    let isMounted = true

    void (async () => {
      const session = await getSession()
      if (!session) {
        if (isMounted) setLoadState('failed')
        return
      }

      const result = await listManagedUsers(session, serverUrl, {
        page: requestedPage,
        perPage: USERS_PER_PAGE,
        search: search || undefined
      })
      if (!isMounted) return

      if (result.outcome !== 'succeeded') {
        setLoadState('failed')
        return
      }

      // A deletion can empty the last page; clamp instead of showing an empty
      // out-of-range page, and let the effect re-run for the clamped page.
      const totalPages = Math.max(1, Math.ceil(result.value.total / result.value.perPage))
      if (result.value.page > totalPages) {
        setRequestedPage(totalPages)
        return
      }

      setPage(result.value)
      setLoadState('ready')
    })()

    return () => {
      isMounted = false
    }
  }, [getSession, loadAttempt, requestedPage, search, serverUrl])

  const refresh = useCallback((): void => {
    setLoadAttempt((attempt) => attempt + 1)
  }, [])

  const runCommand = useCallback(
    async <T>(
      run: (session: AuthenticatedManagementSession) => Promise<ManagementApiResult<T>>,
      toNotice: (value: T) => GovernanceNotice
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

  const createUser = useCallback(
    (input: CreateUserInput): Promise<boolean> =>
      runCommand(
        (session) => createUserRequest(session, serverUrl, input),
        (user) => ({ kind: 'user-created', email: user.email })
      ),
    [runCommand, serverUrl]
  )

  const disableUser = useCallback(
    (user: ManagedUser): Promise<boolean> =>
      runCommand(
        (session) => disableUserRequest(session, serverUrl, user.id),
        () => ({ kind: 'user-disabled', email: user.email })
      ),
    [runCommand, serverUrl]
  )

  const resetPassword = useCallback(
    (user: ManagedUser, initialPassword: string): Promise<boolean> =>
      runCommand(
        (session) => resetUserPasswordRequest(session, serverUrl, user.id, initialPassword),
        () => ({ kind: 'password-reset', email: user.email })
      ),
    [runCommand, serverUrl]
  )

  const changeEmail = useCallback(
    (user: ManagedUser, email: string): Promise<boolean> =>
      runCommand(
        (session) => changeUserEmailRequest(session, serverUrl, user.id, email),
        () => ({ kind: 'email-changed', email })
      ),
    [runCommand, serverUrl]
  )

  const changeRole = useCallback(
    (user: ManagedUser, role: UserRole): Promise<boolean> =>
      runCommand(
        (session) => changeUserRoleRequest(session, serverUrl, user.id, role),
        () => ({ kind: 'role-changed', email: user.email, role })
      ),
    [runCommand, serverUrl]
  )

  const deleteUser = useCallback(
    (user: ManagedUser): Promise<boolean> =>
      runCommand(
        (session) => deleteUserRequest(session, serverUrl, user.id),
        () => ({ kind: 'user-deleted', email: user.email })
      ),
    [runCommand, serverUrl]
  )

  const totalPages = page ? Math.max(1, Math.ceil(page.total / page.perPage)) : 1

  return {
    loadState,
    page,
    totalPages,
    searchDraft,
    setSearchDraft,
    turnToPage: setRequestedPage,
    refresh,
    retry: refresh,
    commandPending,
    commandFailure,
    notice,
    clearNotice: useCallback((): void => setNotice(undefined), []),
    createUser,
    disableUser,
    resetPassword,
    changeEmail,
    changeRole,
    deleteUser
  }
}
