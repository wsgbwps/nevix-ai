import { useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { MoreHorizontalIcon, UserPlusIcon } from 'lucide-react'
import { Avatar, AvatarFallback } from '../../../components/ui/avatar'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../../components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../../../components/ui/dropdown-menu'
import { Field, FieldError, FieldGroup, FieldLabel } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../../../components/ui/select'
import type {
  AuthenticatedManagementSession,
  CreateUserInput,
  ManagedUser,
  ManagementApiFailure
} from '../api/client'
import { useManagedUsers } from '../model/use-managed-users'

type GetSession = () => Promise<AuthenticatedManagementSession | undefined>

type SettingsNavigateSemantics = 'navigable' | 'confirm-discard' | 'blocked'
type SettingsCloseSemantics = 'allow' | 'confirm' | 'defer' | 'deny'

// Structurally mirrors the Settings Flow's SettingsLeaveSemantics contract
// (app/settings); Features do not import across that seam.
export type UserManagementSettingsContribution = {
  readonly navigate: SettingsNavigateSemantics
  readonly close: SettingsCloseSemantics
  readonly discard?: () => void
}

const CLEAN_CONTRIBUTION: UserManagementSettingsContribution = {
  navigate: 'navigable',
  close: 'allow'
}

// A governance command in flight: leaving would abandon it, and closing the
// window must not either.
const COMMAND_UNRESOLVED_CONTRIBUTION: UserManagementSettingsContribution = {
  navigate: 'blocked',
  close: 'deny'
}

// Literal-key map so typed i18n keeps whole-key checking; unknown codes fall back.
const ERROR_CODE_KEYS = {
  invalid_request: 'errors.codes.invalid_request',
  invalid_email: 'errors.codes.invalid_email',
  password_too_short: 'errors.codes.password_too_short',
  invalid_display_name: 'errors.codes.invalid_display_name',
  invalid_role: 'errors.codes.invalid_role',
  invalid_pagination: 'errors.codes.invalid_pagination',
  invalid_search: 'errors.codes.invalid_search',
  email_taken: 'errors.codes.email_taken',
  user_not_found: 'errors.codes.user_not_found',
  last_admin_protected: 'errors.codes.last_admin_protected',
  user_has_logged_in: 'errors.codes.user_has_logged_in',
  internal_error: 'errors.codes.internal_error'
} as const

function failureMessage(failure: ManagementApiFailure, t: TFunction<'userManagement'>): string {
  switch (failure.outcome) {
    case 'network-failure':
      return t('errors.networkFailure')
    case 'unauthorized':
      return t('errors.unauthorized')
    case 'forbidden':
      return t('errors.forbidden')
    case 'request-rejected': {
      const key = Object.hasOwn(ERROR_CODE_KEYS, failure.code)
        ? ERROR_CODE_KEYS[failure.code as keyof typeof ERROR_CODE_KEYS]
        : undefined
      return key !== undefined ? t(key) : t('errors.codeFallback', { code: failure.code })
    }
  }
}

export function UserManagementSettings({
  getSession,
  serverUrl,
  currentUserId,
  onContributionChange
}: {
  readonly getSession: GetSession
  readonly serverUrl: string
  readonly currentUserId: string | undefined
  readonly onContributionChange?: (contribution: UserManagementSettingsContribution) => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation('userManagement')
  const users = useManagedUsers(getSession, serverUrl)
  const [createOpen, setCreateOpen] = useState(false)
  const [resetTarget, setResetTarget] = useState<ManagedUser>()
  const [emailTarget, setEmailTarget] = useState<ManagedUser>()
  const [disableTarget, setDisableTarget] = useState<ManagedUser>()
  const [deleteTarget, setDeleteTarget] = useState<ManagedUser>()
  const anyDialogOpen =
    createOpen ||
    resetTarget !== undefined ||
    emailTarget !== undefined ||
    disableTarget !== undefined ||
    deleteTarget !== undefined

  useEffect(() => {
    onContributionChange?.(
      users.commandPending ? COMMAND_UNRESOLVED_CONTRIBUTION : CLEAN_CONTRIBUTION
    )
  }, [onContributionChange, users.commandPending])

  useEffect(
    () => () => {
      onContributionChange?.(CLEAN_CONTRIBUTION)
    },
    [onContributionChange]
  )

  function closeDialogs(): void {
    setCreateOpen(false)
    setResetTarget(undefined)
    setEmailTarget(undefined)
    setDisableTarget(undefined)
    setDeleteTarget(undefined)
  }

  function guardDialogClose(open: boolean): void {
    // A command in flight owns the dialog; only its outcome may close it.
    if (!open && !users.commandPending) closeDialogs()
  }

  async function changeRole(user: ManagedUser, role: string): Promise<void> {
    if (role !== 'admin' && role !== 'member') return
    if (role === user.role || users.commandPending) return
    await users.changeRole(user, role)
  }

  const lastLoginFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
  const rosterPage = users.page
  const noticeMessage =
    users.notice === undefined
      ? undefined
      : users.notice.kind === 'role-changed'
        ? t('users.notice.roleChanged', {
            email: users.notice.email,
            role: t(`users.role.${users.notice.role}`)
          })
        : t(
            users.notice.kind === 'user-created'
              ? 'users.notice.created'
              : users.notice.kind === 'user-disabled'
                ? 'users.notice.disabled'
                : users.notice.kind === 'password-reset'
                  ? 'users.notice.passwordReset'
                  : users.notice.kind === 'email-changed'
                    ? 'users.notice.emailChanged'
                    : 'users.notice.deleted',
            { email: users.notice.email }
          )

  return (
    <section aria-labelledby="user-management-heading" className="grid gap-5 px-5 py-5">
      <div className="grid gap-1">
        <h2 id="user-management-heading" className="text-base font-semibold">
          {t('users.title')}
        </h2>
        <p className="text-muted-foreground text-sm">{t('users.description')}</p>
      </div>

      {users.loadState === 'failed' ? (
        <div role="alert" className="bg-destructive/10 grid gap-3 rounded-md p-3 text-sm">
          <p>{t('users.loadFailed')}</p>
          <Button type="button" variant="outline" onClick={users.retry}>
            {t('users.retry')}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <Field>
                <FieldLabel htmlFor="user-management-search">{t('users.searchLabel')}</FieldLabel>
                <Input
                  id="user-management-search"
                  value={users.searchDraft}
                  disabled={users.loadState === 'loading'}
                  onChange={(event) => users.setSearchDraft(event.target.value)}
                />
              </Field>
            </div>
            <Button
              type="button"
              disabled={users.commandPending}
              onClick={() => setCreateOpen(true)}
            >
              <UserPlusIcon aria-hidden="true" />
              {t('users.createUser')}
            </Button>
          </div>

          {users.notice !== undefined ? (
            <p role="status" className="text-muted-foreground text-sm">
              {noticeMessage}
            </p>
          ) : null}
          {users.commandFailure !== undefined && !anyDialogOpen ? (
            <p role="alert" className="text-destructive text-sm">
              {failureMessage(users.commandFailure, t)}
            </p>
          ) : null}

          {users.loadState === 'loading' ? (
            <p className="text-muted-foreground py-6 text-center text-sm" role="status">
              {t('users.loading')}
            </p>
          ) : rosterPage === undefined || rosterPage.users.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">{t('users.empty')}</p>
          ) : (
            <div
              role="list"
              aria-label={t('users.rosterLabel')}
              className="divide-y rounded-lg border"
            >
              {rosterPage.users.map((user) => (
                <div
                  key={user.id}
                  role="listitem"
                  className="flex flex-wrap items-center gap-3 px-4 py-3"
                >
                  <Avatar size="sm">
                    <AvatarFallback>{user.displayName.charAt(0).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {user.displayName}
                      {user.id === currentUserId ? (
                        <span className="text-muted-foreground ml-1 font-normal">
                          {t('users.selfSuffix')}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">{user.email}</p>
                  </div>
                  {user.status === 'disabled' ? (
                    <Badge variant="destructive">{t('users.statusDisabled')}</Badge>
                  ) : null}
                  {user.mustChangePassword ? (
                    <Badge variant="secondary">{t('users.pendingPasswordChange')}</Badge>
                  ) : null}
                  <span className="text-muted-foreground w-36 text-right text-xs">
                    {user.lastLoginAt === null
                      ? t('users.neverLoggedIn')
                      : lastLoginFormatter.format(new Date(user.lastLoginAt))}
                  </span>
                  <Select
                    value={user.role}
                    disabled={users.commandPending}
                    onValueChange={(role) => void changeRole(user, role)}
                  >
                    <SelectTrigger
                      className="w-32"
                      aria-label={t('users.roleSelectLabel', { name: user.displayName })}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">{t('users.role.member')}</SelectItem>
                      <SelectItem value="admin">{t('users.role.admin')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={users.commandPending}
                        aria-label={t('users.actionsLabel', { name: user.displayName })}
                      >
                        <MoreHorizontalIcon aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setEmailTarget(user)}>
                        {t('users.action.changeEmail')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setResetTarget(user)}>
                        {t('users.action.resetPassword')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={user.status === 'disabled'}
                        onSelect={() => setDisableTarget(user)}
                      >
                        {t('users.action.disable')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={user.lastLoginAt !== null}
                        variant="destructive"
                        onSelect={() => setDeleteTarget(user)}
                      >
                        {t('users.action.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          )}

          {rosterPage !== undefined ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-muted-foreground text-sm">
                {t('users.pagination', {
                  page: rosterPage.page,
                  totalPages: users.totalPages,
                  total: rosterPage.total
                })}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={rosterPage.page <= 1 || users.commandPending}
                  onClick={() => users.turnToPage(rosterPage.page - 1)}
                >
                  {t('users.previousPage')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={rosterPage.page >= users.totalPages || users.commandPending}
                  onClick={() => users.turnToPage(rosterPage.page + 1)}
                >
                  {t('users.nextPage')}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}

      <CreateUserDialog
        key={createOpen ? 'create-open' : 'create-closed'}
        open={createOpen}
        commandPending={users.commandPending}
        commandFailure={users.commandFailure}
        onOpenChange={guardDialogClose}
        onSubmit={async (input) => {
          const created = await users.createUser(input)
          if (created) closeDialogs()
          return created
        }}
        translate={t}
      />
      <SingleFieldDialog
        key={resetTarget ? `reset-${resetTarget.id}` : 'reset-closed'}
        open={resetTarget !== undefined}
        title={t('users.reset.title', { name: resetTarget?.displayName ?? '' })}
        description={t('users.reset.description')}
        label={t('users.reset.passwordLabel')}
        submitLabel={t('users.reset.submit')}
        type="password"
        commandPending={users.commandPending}
        commandFailure={users.commandFailure}
        onOpenChange={guardDialogClose}
        onSubmit={async (value) => {
          const target = resetTarget
          if (!target) return false
          const reset = await users.resetPassword(target, value)
          if (reset) closeDialogs()
          return reset
        }}
        translate={t}
      />
      <SingleFieldDialog
        key={emailTarget ? `email-${emailTarget.id}` : 'email-closed'}
        open={emailTarget !== undefined}
        title={t('users.email.title', { name: emailTarget?.displayName ?? '' })}
        description={t('users.email.description')}
        label={t('users.email.emailLabel')}
        submitLabel={t('users.email.submit')}
        type="email"
        initialValue={emailTarget?.email}
        commandPending={users.commandPending}
        commandFailure={users.commandFailure}
        onOpenChange={guardDialogClose}
        onSubmit={async (value) => {
          const target = emailTarget
          if (!target) return false
          const changed = await users.changeEmail(target, value)
          if (changed) closeDialogs()
          return changed
        }}
        translate={t}
      />
      <ConfirmDialog
        open={disableTarget !== undefined}
        title={t('users.disable.title', { name: disableTarget?.displayName ?? '' })}
        description={t('users.disable.description')}
        submitLabel={t('users.disable.submit')}
        commandPending={users.commandPending}
        commandFailure={users.commandFailure}
        onOpenChange={guardDialogClose}
        onSubmit={async () => {
          const target = disableTarget
          if (!target) return false
          const disabled = await users.disableUser(target)
          if (disabled) closeDialogs()
          return disabled
        }}
        translate={t}
      />
      <ConfirmDialog
        open={deleteTarget !== undefined}
        title={t('users.delete.title', { name: deleteTarget?.displayName ?? '' })}
        description={t('users.delete.description')}
        submitLabel={t('users.delete.submit')}
        destructive
        commandPending={users.commandPending}
        commandFailure={users.commandFailure}
        onOpenChange={guardDialogClose}
        onSubmit={async () => {
          const target = deleteTarget
          if (!target) return false
          const deleted = await users.deleteUser(target)
          if (deleted) closeDialogs()
          return deleted
        }}
        translate={t}
      />
    </section>
  )
}

function CommandFailureLine({
  failure,
  translate: t
}: {
  readonly failure: ManagementApiFailure | undefined
  readonly translate: TFunction<'userManagement'>
}): React.JSX.Element | null {
  if (failure === undefined) return null
  return (
    <p role="alert" className="text-destructive text-sm">
      {failureMessage(failure, t)}
    </p>
  )
}

function CreateUserDialog({
  open,
  commandPending,
  commandFailure,
  onOpenChange,
  onSubmit,
  translate: t
}: {
  readonly open: boolean
  readonly commandPending: boolean
  readonly commandFailure: ManagementApiFailure | undefined
  readonly onOpenChange: (open: boolean) => void
  readonly onSubmit: (input: CreateUserInput) => Promise<boolean>
  readonly translate: TFunction<'userManagement'>
}): React.JSX.Element {
  const [email, setEmail] = useState('')
  const [initialPassword, setInitialPassword] = useState('')
  const [displayName, setDisplayName] = useState('')

  const trimmedEmail = email.trim()
  const canSubmit = trimmedEmail.length > 0 && initialPassword.length > 0 && !commandPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('users.create.title')}</DialogTitle>
          <DialogDescription>{t('users.create.description')}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSubmit) return
            void onSubmit({
              email: trimmedEmail,
              initialPassword,
              displayName: displayName.trim() || undefined
            })
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="create-user-email">{t('users.create.emailLabel')}</FieldLabel>
              <Input
                id="create-user-email"
                type="email"
                autoComplete="off"
                value={email}
                disabled={commandPending}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="create-user-initial-password">
                {t('users.create.initialPasswordLabel')}
              </FieldLabel>
              <Input
                id="create-user-initial-password"
                type="password"
                autoComplete="new-password"
                value={initialPassword}
                disabled={commandPending}
                onChange={(event) => setInitialPassword(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="create-user-display-name">
                {t('users.create.displayNameLabel')}
              </FieldLabel>
              <Input
                id="create-user-display-name"
                value={displayName}
                disabled={commandPending}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </Field>
            <CommandFailureLine failure={commandFailure} translate={t} />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={commandPending}>
                  {t('common.cancel')}
                </Button>
              </DialogClose>
              <Button type="submit" disabled={!canSubmit}>
                {t('users.create.submit')}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SingleFieldDialog({
  open,
  title,
  description,
  label,
  submitLabel,
  type,
  initialValue,
  commandPending,
  commandFailure,
  onOpenChange,
  onSubmit,
  translate: t
}: {
  readonly open: boolean
  readonly title: string
  readonly description: string
  readonly label: string
  readonly submitLabel: string
  readonly type: 'email' | 'password'
  readonly initialValue?: string
  readonly commandPending: boolean
  readonly commandFailure: ManagementApiFailure | undefined
  readonly onOpenChange: (open: boolean) => void
  readonly onSubmit: (value: string) => Promise<boolean>
  readonly translate: TFunction<'userManagement'>
}): React.JSX.Element {
  const [value, setValue] = useState(type === 'email' ? (initialValue ?? '') : '')

  const trimmedValue = value.trim()
  const canSubmit = trimmedValue.length > 0 && !commandPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSubmit) return
            void onSubmit(trimmedValue)
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="user-management-dialog-field">{label}</FieldLabel>
              <Input
                id="user-management-dialog-field"
                type={type}
                autoComplete={type === 'password' ? 'new-password' : 'off'}
                value={value}
                disabled={commandPending}
                onChange={(event) => setValue(event.target.value)}
              />
              <FieldError />
            </Field>
            <CommandFailureLine failure={commandFailure} translate={t} />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={commandPending}>
                  {t('common.cancel')}
                </Button>
              </DialogClose>
              <Button type="submit" disabled={!canSubmit}>
                {submitLabel}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ConfirmDialog({
  open,
  title,
  description,
  submitLabel,
  destructive = false,
  commandPending,
  commandFailure,
  onOpenChange,
  onSubmit,
  translate: t
}: {
  readonly open: boolean
  readonly title: string
  readonly description: string
  readonly submitLabel: string
  readonly destructive?: boolean
  readonly commandPending: boolean
  readonly commandFailure: ManagementApiFailure | undefined
  readonly onOpenChange: (open: boolean) => void
  readonly onSubmit: () => Promise<boolean>
  readonly translate: TFunction<'userManagement'>
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <CommandFailureLine failure={commandFailure} translate={t} />
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={commandPending}>
              {t('common.cancel')}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant={destructive ? 'destructive' : 'default'}
            disabled={commandPending}
            onClick={() => void onSubmit()}
          >
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
