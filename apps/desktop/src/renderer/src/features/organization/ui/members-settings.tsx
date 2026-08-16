import { useCallback, useEffect, useState } from 'react'
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

type GetSession = () => Promise<AuthenticatedOrganizationSession | undefined>

export function MembersSettings({
  getSession
}: {
  readonly getSession: GetSession
}): React.JSX.Element | null {
  const { t } = useTranslation('organization')
  const {
    activeOrganization,
    leaveActiveOrganization,
    membershipVerification,
    verifyActiveMembership
  } = useActiveOrganization()
  const activeOrganizationId = activeOrganization?.organizationId
  const [loadedRosterOrganizationId, setLoadedRosterOrganizationId] = useState<string>()
  const [verificationPending, setVerificationPending] = useState(false)
  const recordRosterLoaded = useCallback((): void => {
    if (activeOrganizationId) setLoadedRosterOrganizationId(activeOrganizationId)
  }, [activeOrganizationId])

  async function retryMembershipVerification(): Promise<void> {
    if (!activeOrganizationId || verificationPending) return

    setVerificationPending(true)
    try {
      await verifyActiveMembership()
    } finally {
      setVerificationPending(false)
    }
  }
  if (!activeOrganization) return null
  const providerVerificationStatus =
    membershipVerification?.status === 'verified'
      ? membershipVerification.membership.organizationId === activeOrganization.organizationId
        ? 'verified'
        : undefined
      : membershipVerification?.organizationId === activeOrganization.organizationId
        ? membershipVerification.status
        : undefined
  const authorityFresh = providerVerificationStatus === 'verified'
  const hasVerifiedMembership =
    authorityFresh || loadedRosterOrganizationId === activeOrganization.organizationId
  if (!hasVerifiedMembership) {
    return (
      <section aria-labelledby="members-heading" className="grid gap-3">
        <h2 id="members-heading" className="text-base font-semibold">
          {t('members.title')}
        </h2>
        {providerVerificationStatus === 'unknown' ? (
          <>
            <p role="alert" className="text-destructive text-sm">
              {t('members.verificationUnknown')}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="justify-self-start"
              aria-label={t('members.retryVerificationAria')}
              disabled={verificationPending}
              onClick={() => void retryMembershipVerification()}
            >
              {t('members.retry')}
            </Button>
          </>
        ) : (
          <p className="text-muted-foreground text-sm">{t('members.loading')}</p>
        )}
      </section>
    )
  }

  return (
    <MembersSettingsContent
      key={`${activeOrganization.organizationId}:${activeOrganization.role}`}
      getSession={getSession}
      organization={activeOrganization}
      leaveActiveOrganization={leaveActiveOrganization}
      authorityFresh={authorityFresh}
      retryVerification={() => void retryMembershipVerification()}
      rosterLoaded={recordRosterLoaded}
      translate={t}
    />
  )
}

function MembersSettingsContent({
  getSession,
  organization,
  leaveActiveOrganization,
  authorityFresh,
  retryVerification,
  rosterLoaded,
  translate: t
}: {
  readonly getSession: GetSession
  readonly organization: ActiveMembership
  readonly leaveActiveOrganization: () => Promise<void>
  readonly authorityFresh: boolean
  readonly retryVerification: () => void
  readonly rosterLoaded: () => void
  readonly translate: TFunction<'organization'>
}): React.JSX.Element {
  const management = useMembersManagement({ getSession, organization, authorityFresh })

  useEffect(() => {
    if (management.loadState === 'ready') rosterLoaded()
  }, [management.loadState, rosterLoaded])
  const canManage =
    authorityFresh && (organization.role === 'owner' || organization.role === 'admin')
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

      {!authorityFresh ? (
        <div className="grid justify-items-start gap-3">
          <p role="alert" className="text-destructive text-sm">
            {t('members.verificationUnknown')}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t('members.retryVerificationAria')}
            onClick={retryVerification}
          >
            {t('members.retry')}
          </Button>
        </div>
      ) : null}

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
              key={authorityFresh ? 'fresh' : 'unknown'}
              actionsEnabled={authorityFresh}
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
          {authorityFresh ? (
            <p className="text-muted-foreground text-sm">{t('members.memberReadOnly')}</p>
          ) : null}
          <MemberRoster
            key={authorityFresh ? 'fresh' : 'unknown'}
            actionsEnabled={authorityFresh}
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
