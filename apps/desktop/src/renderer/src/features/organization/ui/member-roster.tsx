import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar, AvatarFallback } from '../../../components/ui/avatar'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../../../components/ui/select'
import type { ActiveMembership, OrganizationMember } from '../api/memberships'

export function MemberRoster({
  actionsEnabled,
  organization,
  members,
  currentUserId,
  isMutating,
  actionError,
  clearNotice,
  promoteMember,
  demoteMember,
  removeMember,
  leaveOrganization
}: {
  readonly actionsEnabled: boolean
  readonly organization: ActiveMembership
  readonly members: readonly OrganizationMember[]
  readonly currentUserId: string | undefined
  readonly isMutating: boolean
  readonly actionError: string | undefined
  readonly clearNotice: () => void
  readonly promoteMember: (member: OrganizationMember) => Promise<boolean>
  readonly demoteMember: (member: OrganizationMember) => Promise<boolean>
  readonly removeMember: (member: OrganizationMember) => Promise<boolean>
  readonly leaveOrganization: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('organization')
  const [removalTarget, setRemovalTarget] = useState<OrganizationMember>()
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [leaveError, setLeaveError] = useState<string>()

  async function selectRole(member: OrganizationMember, role: string): Promise<void> {
    if (!actionsEnabled || role === member.role || isMutating) return
    if (role === 'admin' && member.role === 'member') {
      await promoteMember(member)
    } else if (role === 'member' && member.role === 'admin') {
      await demoteMember(member)
    }
  }

  async function confirmRemoval(): Promise<void> {
    if (!actionsEnabled || !removalTarget || isMutating) return
    if (await removeMember(removalTarget)) setRemovalTarget(undefined)
  }

  async function confirmLeave(): Promise<void> {
    if (!actionsEnabled || isMutating) return
    setLeaveError(undefined)
    try {
      await leaveOrganization()
    } catch {
      setLeaveError(t('members.actionFailed'))
    }
  }

  return (
    <>
      <div aria-label={t('members.membersTab')} className="divide-y rounded-lg border">
        {members.map((member) => {
          const isCurrentUser = member.userId === currentUserId
          const canChangeRole =
            actionsEnabled &&
            organization.role === 'owner' &&
            !isCurrentUser &&
            (member.role === 'admin' || member.role === 'member')
          const canRemove =
            actionsEnabled &&
            !isCurrentUser &&
            member.role !== 'owner' &&
            (organization.role === 'owner' ||
              (organization.role === 'admin' && member.role === 'member'))
          const canLeave =
            actionsEnabled &&
            isCurrentUser &&
            (organization.role === 'admin' || organization.role === 'member')

          return (
            <div key={member.membershipId} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Avatar>
                <AvatarFallback>{member.displayName.charAt(0).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {isCurrentUser ? (
                    <>
                      <span>{member.displayName}</span>
                      <span className="text-muted-foreground ml-1 font-normal">
                        {t('common.youSuffix')}
                      </span>
                    </>
                  ) : (
                    member.displayName
                  )}
                </p>
                <p className="text-muted-foreground text-xs">{t(`common.roles.${member.role}`)}</p>
              </div>

              {canChangeRole ? (
                <Select
                  value={member.role}
                  disabled={isMutating}
                  onValueChange={(role) => void selectRole(member, role)}
                >
                  <SelectTrigger
                    className="w-36"
                    aria-label={t('members.changeRoleAria', { name: member.displayName })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">{t('common.roles.member')}</SelectItem>
                    <SelectItem value="admin">{t('common.roles.admin')}</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}

              {canRemove ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={isMutating}
                  aria-label={t('members.removeAria', { name: member.displayName })}
                  onClick={() => {
                    clearNotice()
                    setRemovalTarget(member)
                  }}
                >
                  {t('members.remove')}
                </Button>
              ) : null}

              {canLeave ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isMutating}
                  aria-label={t('members.leaveAria', { name: member.displayName })}
                  onClick={() => {
                    setLeaveError(undefined)
                    setLeaveOpen(true)
                  }}
                >
                  {t('members.leave')}
                </Button>
              ) : null}
            </div>
          )
        })}
      </div>

      <Dialog
        open={removalTarget !== undefined}
        onOpenChange={(open) => {
          if (!open && !isMutating) setRemovalTarget(undefined)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {t('members.removeTitle', { name: removalTarget?.displayName })}
            </DialogTitle>
            <DialogDescription>{t('members.removeDescription')}</DialogDescription>
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
              onClick={() => void confirmRemoval()}
            >
              {t('members.confirmRemove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={leaveOpen}
        onOpenChange={(open) => {
          if (!open && !isMutating) setLeaveOpen(false)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {t('members.leaveTitle', { org: organization.organizationName })}
            </DialogTitle>
            <DialogDescription>{t('members.leaveDescription')}</DialogDescription>
          </DialogHeader>
          {leaveError ? (
            <p role="alert" className="text-destructive text-sm">
              {leaveError}
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
              onClick={() => void confirmLeave()}
            >
              {t('members.confirmLeave')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
