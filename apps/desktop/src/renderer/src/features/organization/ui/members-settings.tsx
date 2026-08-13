import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs'
import type { AuthenticatedOrganizationSession } from '../api/client'
import type { ActiveMembership } from '../api/memberships'
import { type MembersManagementNotice, useMembersManagement } from '../model/members-management'
import { useActiveOrganization } from '../model/active-organization-state'
import { MemberRoster } from './member-roster'
import { OrganizationInvitations } from './organization-invitations'
import { OrganizationNameSettings } from './organization-name-settings'

type GetSession = () => Promise<AuthenticatedOrganizationSession | undefined>

export function MembersSettings({
  getSession
}: {
  readonly getSession: GetSession
}): React.JSX.Element | null {
  const { t } = useTranslation('organization')
  const { activeOrganization, leaveActiveOrganization, updateActiveOrganizationName } =
    useActiveOrganization()

  if (!activeOrganization) return null

  return (
    <MembersSettingsContent
      key={`${activeOrganization.organizationId}:${activeOrganization.role}`}
      getSession={getSession}
      organization={activeOrganization}
      leaveActiveOrganization={leaveActiveOrganization}
      updateActiveOrganizationName={updateActiveOrganizationName}
      translate={t}
    />
  )
}

function MembersSettingsContent({
  getSession,
  organization,
  leaveActiveOrganization,
  updateActiveOrganizationName,
  translate: t
}: {
  readonly getSession: GetSession
  readonly organization: ActiveMembership
  readonly leaveActiveOrganization: () => Promise<void>
  readonly updateActiveOrganizationName: (name: string) => Promise<void>
  readonly translate: TFunction<'organization'>
}): React.JSX.Element {
  const management = useMembersManagement({ getSession, organization })
  const canManage = organization.role === 'owner' || organization.role === 'admin'
  const noticeMessage = messageForNotice(management.notice, t)
  const actionError = management.notice?.kind === 'error' ? noticeMessage : undefined
  return (
    <section aria-labelledby="members-heading" className="grid gap-5">
      <div id="members" className="grid gap-1">
        <h2 id="members-heading" className="text-base font-semibold">
          {t('members.title')}
        </h2>
        <p className="text-muted-foreground text-sm">
          {t('common.memberCount', { count: management.members.length })}
        </p>
      </div>

      <OrganizationNameSettings
        organization={organization}
        updateName={updateActiveOrganizationName}
      />

      {management.loadState === 'loading' ? (
        <p className="text-muted-foreground text-sm">{t('members.loading')}</p>
      ) : management.loadState === 'error' ? (
        <div className="grid justify-items-start gap-3">
          <p role="alert" className="text-destructive text-sm">
            {t('members.loadError')}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t('members.retryLoadAria')}
            onClick={() => void management.reload()}
          >
            {t('members.retry')}
          </Button>
        </div>
      ) : canManage ? (
        <Tabs defaultValue="members">
          <TabsList>
            <TabsTrigger value="members">{t('members.membersTab')}</TabsTrigger>
            <TabsTrigger value="invitations">
              {t('members.invitesTab')}
              <Badge variant="secondary">{management.pendingInvitations.length}</Badge>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="members" className="grid gap-4">
            <MemberRoster
              organization={organization}
              members={management.members}
              currentUserId={management.currentUserId}
              isMutating={management.isMutating}
              actionError={actionError}
              clearNotice={management.clearNotice}
              promoteMember={management.promoteMember}
              demoteMember={management.demoteMember}
              removeMember={management.removeMember}
              leaveOrganization={leaveActiveOrganization}
            />
          </TabsContent>
          <TabsContent value="invitations" className="grid gap-4">
            <OrganizationInvitations
              invitations={management.pendingInvitations}
              isMutating={management.isMutating}
              actionError={actionError}
              clearNotice={management.clearNotice}
              createInvitation={management.createInvitation}
              resendInvitation={management.resendInvitation}
              revokeInvitation={management.revokeInvitation}
            />
          </TabsContent>
        </Tabs>
      ) : (
        <div className="grid gap-4">
          <p className="text-muted-foreground text-sm">{t('members.memberReadOnly')}</p>
          <MemberRoster
            organization={organization}
            members={management.members}
            currentUserId={management.currentUserId}
            isMutating={management.isMutating}
            actionError={actionError}
            clearNotice={management.clearNotice}
            promoteMember={management.promoteMember}
            demoteMember={management.demoteMember}
            removeMember={management.removeMember}
            leaveOrganization={leaveActiveOrganization}
          />
        </div>
      )}

      {noticeMessage ? (
        <p
          role={management.notice?.kind === 'error' ? 'alert' : 'status'}
          className={
            management.notice?.kind === 'error'
              ? 'text-destructive text-sm'
              : 'text-muted-foreground text-sm'
          }
        >
          {noticeMessage}
        </p>
      ) : null}
    </section>
  )
}

function messageForNotice(
  notice: MembersManagementNotice | undefined,
  t: TFunction<'organization'>
): string | undefined {
  if (!notice) return undefined

  switch (notice.kind) {
    case 'sent':
      return t('members.sent', { email: notice.email })
    case 'resent':
      return t('members.resent')
    case 'revoked':
      return t('members.revoked')
    case 'roleUpdated':
      return t('members.roleUpdated', { name: notice.displayName })
    case 'error':
      switch (notice.code) {
        case 'active_membership_exists':
          return t('members.activeMembershipExists')
        case 'pending_invitation_exists':
          return t('members.pendingInvitationExists')
        case 'cooldown_active':
          return notice.retryAfterSeconds === undefined
            ? t('members.actionFailed')
            : t('members.cooldownActive', { seconds: notice.retryAfterSeconds })
        case 'email_rate_limited':
        case 'ip_rate_limited':
          return t('members.invitationRateLimited')
        default:
          return t('members.actionFailed')
      }
  }
}
