import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import type { PendingOrganizationInvitation } from '../api/admin-invitations'

const invitationDayMilliseconds = 24 * 60 * 60 * 1000

export function OrganizationInvitations({
  invitations,
  isMutating,
  actionError,
  clearNotice,
  createInvitation,
  resendInvitation,
  revokeInvitation
}: {
  readonly invitations: readonly PendingOrganizationInvitation[]
  readonly isMutating: boolean
  readonly actionError: string | undefined
  readonly clearNotice: () => void
  readonly createInvitation: (email: string) => Promise<boolean>
  readonly resendInvitation: (invitationId: string) => Promise<boolean>
  readonly revokeInvitation: (invitationId: string) => Promise<boolean>
}): React.JSX.Element {
  const { t } = useTranslation('organization')
  const [createOpen, setCreateOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [resendTarget, setResendTarget] = useState<PendingOrganizationInvitation>()
  const [revokeTarget, setRevokeTarget] = useState<PendingOrganizationInvitation>()
  const [referenceTime] = useState(Date.now)

  async function submitInvitation(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (isMutating) return
    if (await createInvitation(email)) {
      setCreateOpen(false)
      setEmail('')
    }
  }

  async function confirmResend(): Promise<void> {
    if (!resendTarget || isMutating) return
    if (await resendInvitation(resendTarget.id)) setResendTarget(undefined)
  }

  async function confirmRevoke(): Promise<void> {
    if (!revokeTarget || isMutating) return
    if (await revokeInvitation(revokeTarget.id)) setRevokeTarget(undefined)
  }

  return (
    <>
      <div className="flex justify-end">
        <Button
          type="button"
          disabled={isMutating}
          onClick={() => {
            clearNotice()
            setCreateOpen(true)
          }}
        >
          {t('members.inviteCta')}
        </Button>
      </div>
      {invitations.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('members.emptyInvites')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {invitations.map((invitation) => {
            const days = Math.max(
              0,
              Math.ceil(
                (Date.parse(invitation.expiresAt) - referenceTime) / invitationDayMilliseconds
              )
            )
            return (
              <li key={invitation.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{invitation.email}</p>
                  <p className="text-muted-foreground text-xs">{t('members.expires', { days })}</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={isMutating}
                  aria-label={t('members.resendAria', { email: invitation.email })}
                  onClick={() => {
                    clearNotice()
                    setResendTarget(invitation)
                  }}
                >
                  {t('members.resend')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={isMutating}
                  aria-label={t('members.revokeAria', { email: invitation.email })}
                  onClick={() => {
                    clearNotice()
                    setRevokeTarget(invitation)
                  }}
                >
                  {t('members.revoke')}
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open && !isMutating) setCreateOpen(false)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t('members.inviteDialogTitle')}</DialogTitle>
            <DialogDescription>{t('members.inviteDialogDescription')}</DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void submitInvitation(event)}>
            <FieldGroup>
              <Field data-invalid={actionError !== undefined || undefined}>
                <FieldLabel htmlFor="organization-invitation-email">{t('common.email')}</FieldLabel>
                <Input
                  id="organization-invitation-email"
                  type="email"
                  required
                  value={email}
                  placeholder={t('common.emailPlaceholder')}
                  disabled={isMutating}
                  aria-invalid={actionError !== undefined || undefined}
                  onChange={(event) => {
                    setEmail(event.target.value)
                    clearNotice()
                  }}
                />
                <FieldError>{actionError}</FieldError>
              </Field>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline" disabled={isMutating}>
                    {t('common.cancel')}
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={isMutating}>
                  {t('members.send')}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={resendTarget !== undefined}
        onOpenChange={(open) => {
          if (!open && !isMutating) setResendTarget(undefined)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t('members.resend')}</DialogTitle>
            <DialogDescription>{resendTarget?.email}</DialogDescription>
          </DialogHeader>
          {actionError ? (
            <p role="alert" className="text-destructive text-sm">
              {actionError}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isMutating}>
                {t('common.cancel')}
              </Button>
            </DialogClose>
            <Button type="button" disabled={isMutating} onClick={() => void confirmResend()}>
              {t('members.resend')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={revokeTarget !== undefined}
        onOpenChange={(open) => {
          if (!open && !isMutating) setRevokeTarget(undefined)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t('members.revoke')}</DialogTitle>
            <DialogDescription>{revokeTarget?.email}</DialogDescription>
          </DialogHeader>
          {actionError ? (
            <p role="alert" className="text-destructive text-sm">
              {actionError}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isMutating}>
                {t('common.cancel')}
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={isMutating}
              onClick={() => void confirmRevoke()}
            >
              {t('members.revoke')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
