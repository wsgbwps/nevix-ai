import { useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { KeyRoundIcon } from 'lucide-react'
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
import { Field, FieldError, FieldGroup, FieldLabel } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import type { AuthenticatedManagementSession, JoinCode, ManagementApiFailure } from '../api/client'
import { useJoinCodes } from '../model/use-join-codes'

type GetSession = () => Promise<AuthenticatedManagementSession | undefined>

type SettingsNavigateSemantics = 'navigable' | 'confirm-discard' | 'blocked'
type SettingsCloseSemantics = 'allow' | 'confirm' | 'defer' | 'deny'

// Structurally mirrors the Settings Flow's SettingsLeaveSemantics contract
// (app/settings); Features do not import across that seam.
export type JoinCodesSettingsContribution = {
  readonly navigate: SettingsNavigateSemantics
  readonly close: SettingsCloseSemantics
  readonly discard?: () => void
}

const CLEAN_CONTRIBUTION: JoinCodesSettingsContribution = {
  navigate: 'navigable',
  close: 'allow'
}

// A command in flight: leaving would abandon it, and closing the window must
// not either.
const COMMAND_UNRESOLVED_CONTRIBUTION: JoinCodesSettingsContribution = {
  navigate: 'blocked',
  close: 'deny'
}

// Literal-key map so typed i18n keeps whole-key checking; unknown codes fall back.
const ERROR_CODE_KEYS = {
  invalid_request: 'errors.codes.invalid_request',
  invalid_label: 'errors.codes.invalid_label',
  too_many_active_join_codes: 'errors.codes.too_many_active_join_codes',
  join_code_not_found: 'errors.codes.join_code_not_found',
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

/**
 * The Admin's join-code governance card (issue #120): the active plaintext
 * codes with their notes, one command to issue (optional label) and one to
 * revoke. Revoking every active code is how self-registration closes — there
 * is no separate toggle.
 */
export function JoinCodesSettings({
  getSession,
  serverUrl,
  onContributionChange
}: {
  readonly getSession: GetSession
  readonly serverUrl: string
  readonly onContributionChange?: (contribution: JoinCodesSettingsContribution) => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation('userManagement')
  const joinCodesState = useJoinCodes(getSession, serverUrl)
  const [issueOpen, setIssueOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<JoinCode>()
  const anyDialogOpen = issueOpen || revokeTarget !== undefined

  useEffect(() => {
    onContributionChange?.(
      joinCodesState.commandPending ? COMMAND_UNRESOLVED_CONTRIBUTION : CLEAN_CONTRIBUTION
    )
  }, [onContributionChange, joinCodesState.commandPending])

  useEffect(
    () => () => {
      onContributionChange?.(CLEAN_CONTRIBUTION)
    },
    [onContributionChange]
  )

  function closeDialogs(): void {
    setIssueOpen(false)
    setRevokeTarget(undefined)
  }

  function guardDialogClose(open: boolean): void {
    // A command in flight owns the dialog; only its outcome may close it.
    if (!open && !joinCodesState.commandPending) closeDialogs()
  }

  const createdFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
  const noticeMessage =
    joinCodesState.notice === undefined
      ? undefined
      : joinCodesState.notice.kind === 'join-code-created'
        ? t('joinCodes.notice.created', { code: joinCodesState.notice.code })
        : t('joinCodes.notice.revoked')

  return (
    <section aria-labelledby="join-codes-heading" className="grid gap-5 px-5 py-5">
      <div className="grid gap-1">
        <h2 id="join-codes-heading" className="text-base font-semibold">
          {t('joinCodes.title')}
        </h2>
        <p className="text-muted-foreground text-sm">{t('joinCodes.description')}</p>
      </div>

      {joinCodesState.loadState === 'failed' ? (
        <div role="alert" className="bg-destructive/10 grid gap-3 rounded-md p-3 text-sm">
          <p>{t('joinCodes.loadFailed')}</p>
          <Button type="button" variant="outline" onClick={joinCodesState.retry}>
            {t('joinCodes.retry')}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground text-sm">
              {t('joinCodes.activeCount', { count: joinCodesState.joinCodes.length })}
            </p>
            <Button
              type="button"
              disabled={joinCodesState.commandPending}
              onClick={() => setIssueOpen(true)}
            >
              <KeyRoundIcon aria-hidden="true" />
              {t('joinCodes.issue.submit')}
            </Button>
          </div>

          {joinCodesState.notice !== undefined ? (
            <p role="status" className="text-muted-foreground text-sm">
              {noticeMessage}
            </p>
          ) : null}
          {joinCodesState.commandFailure !== undefined && !anyDialogOpen ? (
            <p role="alert" className="text-destructive text-sm">
              {failureMessage(joinCodesState.commandFailure, t)}
            </p>
          ) : null}

          {joinCodesState.loadState === 'loading' ? (
            <p className="text-muted-foreground py-6 text-center text-sm" role="status">
              {t('joinCodes.loading')}
            </p>
          ) : joinCodesState.joinCodes.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">{t('joinCodes.empty')}</p>
          ) : (
            <div
              role="list"
              aria-label={t('joinCodes.listLabel')}
              className="divide-y rounded-lg border"
            >
              {joinCodesState.joinCodes.map((joinCode) => (
                <div
                  key={joinCode.id}
                  role="listitem"
                  className="flex flex-wrap items-center gap-3 px-4 py-3"
                >
                  <span className="font-mono text-base font-semibold tracking-wide select-all">
                    {joinCode.code}
                  </span>
                  {joinCode.label === '' ? (
                    <Badge variant="secondary">{t('joinCodes.unlabeled')}</Badge>
                  ) : (
                    <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                      {joinCode.label}
                    </span>
                  )}
                  <span className="text-muted-foreground w-44 text-right text-xs">
                    {t('joinCodes.createdAt', {
                      time: createdFormatter.format(new Date(joinCode.createdAt))
                    })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={joinCodesState.commandPending}
                    aria-label={t('joinCodes.revoke.actionLabel', { code: joinCode.code })}
                    onClick={() => setRevokeTarget(joinCode)}
                  >
                    {t('joinCodes.revoke.submit')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <IssueJoinCodeDialog
        key={issueOpen ? 'issue-open' : 'issue-closed'}
        open={issueOpen}
        commandPending={joinCodesState.commandPending}
        commandFailure={joinCodesState.commandFailure}
        onOpenChange={guardDialogClose}
        onSubmit={async (label) => {
          const issued = await joinCodesState.createJoinCode(label)
          if (issued) closeDialogs()
          return issued
        }}
        translate={t}
      />
      <RevokeJoinCodeDialog
        open={revokeTarget !== undefined}
        joinCode={revokeTarget}
        commandPending={joinCodesState.commandPending}
        commandFailure={joinCodesState.commandFailure}
        onOpenChange={guardDialogClose}
        onSubmit={async () => {
          const target = revokeTarget
          if (!target) return false
          const revoked = await joinCodesState.revokeJoinCode(target)
          if (revoked) closeDialogs()
          return revoked
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

function IssueJoinCodeDialog({
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
  readonly onSubmit: (label: string | undefined) => Promise<boolean>
  readonly translate: TFunction<'userManagement'>
}): React.JSX.Element {
  const [label, setLabel] = useState('')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('joinCodes.issue.title')}</DialogTitle>
          <DialogDescription>{t('joinCodes.issue.description')}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (commandPending) return
            void onSubmit(label.trim() === '' ? undefined : label.trim())
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="join-code-label">{t('joinCodes.issue.labelLabel')}</FieldLabel>
              <Input
                id="join-code-label"
                value={label}
                disabled={commandPending}
                onChange={(event) => setLabel(event.target.value)}
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
              <Button type="submit" disabled={commandPending}>
                {t('joinCodes.issue.submit')}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RevokeJoinCodeDialog({
  open,
  joinCode,
  commandPending,
  commandFailure,
  onOpenChange,
  onSubmit,
  translate: t
}: {
  readonly open: boolean
  readonly joinCode: JoinCode | undefined
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
          <DialogTitle>{t('joinCodes.revoke.title', { code: joinCode?.code ?? '' })}</DialogTitle>
          <DialogDescription>{t('joinCodes.revoke.description')}</DialogDescription>
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
            variant="destructive"
            disabled={commandPending}
            onClick={() => void onSubmit()}
          >
            {t('joinCodes.revoke.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
