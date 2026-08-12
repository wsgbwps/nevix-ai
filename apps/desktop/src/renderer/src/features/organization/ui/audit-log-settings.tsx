import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollTextIcon } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../../../components/ui/select'
import type { AuthenticatedOrganizationSession } from '../api/client'
import { readAuditLogEntries, type AuditLogEntry } from '../api/audit-logs'
import { serializeAuditLogCsv } from '../lib/audit-log-csv'
import {
  groupAuditLogEntriesByDay,
  formatAuditLogDay,
  formatAuditLogTime
} from '../lib/audit-log-timeline'
import { auditLogTargetDisplayName } from '../lib/audit-log-target'
import type { ActiveMembership } from '../api/memberships'
import { useActiveOrganization } from '../model/active-organization-state'

type GetSession = () => Promise<AuthenticatedOrganizationSession | undefined>

const actionTranslationKeys = {
  invitation_created: 'audit.actions.invitationCreated',
  invitation_resent: 'audit.actions.invitationResent',
  invitation_revoked: 'audit.actions.invitationRevoked',
  invitation_accepted: 'audit.actions.invitationAccepted',
  membership_left: 'audit.actions.membershipLeft',
  member_removed: 'audit.actions.memberRemoved',
  admin_promoted: 'audit.actions.adminPromoted',
  admin_demoted: 'audit.actions.adminDemoted',
  admin_removed: 'audit.actions.adminRemoved',
  organization_settings_updated: 'audit.actions.organizationSettingsUpdated'
} as const

function actionTranslationKey(
  action: string
): (typeof actionTranslationKeys)[keyof typeof actionTranslationKeys] | undefined {
  if (!Object.hasOwn(actionTranslationKeys, action)) return undefined
  return actionTranslationKeys[action as keyof typeof actionTranslationKeys]
}

/** The UI mirrors the Data API policy: only Owners and Admins may view audit events. */
function canViewAuditLog(
  organization: ActiveMembership | undefined
): organization is ActiveMembership {
  return organization?.role === 'owner' || organization?.role === 'admin'
}

/**
 * This contribution owns Organization-specific Settings navigation and its access rule. The
 * Settings composition root only places it beside other feature contributions.
 */
export function AuditLogSettingsNavigation(): React.JSX.Element | null {
  const { t } = useTranslation('organization')
  const { activeOrganization } = useActiveOrganization()

  if (!canViewAuditLog(activeOrganization)) return null

  return (
    <div className="grid gap-1">
      <p className="text-muted-foreground px-2.5 text-xs font-medium tracking-wide uppercase">
        {t('audit.settingsGroup')}
      </p>
      <button
        type="button"
        aria-controls="audit-log"
        onClick={() => document.getElementById('audit-log')?.scrollIntoView({ block: 'start' })}
        className="text-sidebar-foreground hover:bg-sidebar-accent flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium"
      >
        <ScrollTextIcon className="size-4" />
        {t('audit.title')}
      </button>
    </div>
  )
}

export function AuditLogSettings({
  getSession
}: {
  readonly getSession: GetSession
}): React.JSX.Element | null {
  const { t, i18n } = useTranslation('organization')
  const { verification, retry } = useVerifiedAuditLogOrganization()
  const [entries, setEntries] = useState<readonly AuditLogEntry[]>([])
  const [actionFilter, setActionFilter] = useState<string>('all')
  const [isExporting, setIsExporting] = useState(false)
  const [exportedEntryCount, setExportedEntryCount] = useState<number>()
  const organization = verification?.status === 'authorized' ? verification.membership : undefined

  useEffect(() => {
    let isMounted = true
    if (!organization) return

    void (async () => {
      try {
        const session = await getSession()
        if (!session) throw new Error('Audit Log Session is unavailable.')
        const nextEntries = await readAuditLogEntries(
          session,
          organization.organizationId,
          actionFilter === 'all' ? undefined : actionFilter
        )
        if (isMounted) setEntries(nextEntries)
      } catch {
        if (isMounted) setEntries([])
      }
    })()

    return () => {
      isMounted = false
    }
  }, [actionFilter, getSession, organization])

  if (!verification || verification.status === 'denied') return null

  const organizationId = organization?.organizationId
  const groups = groupAuditLogEntriesByDay(entries)

  async function exportAuditLog(): Promise<void> {
    if (isExporting || !organizationId) return

    setIsExporting(true)
    setExportedEntryCount(undefined)
    try {
      const session = await getSession()
      if (!session) throw new Error('Audit Log Session is unavailable.')
      const exportEntries = await readAuditLogEntries(
        session,
        organizationId,
        actionFilter === 'all' ? undefined : actionFilter
      )
      const csv = serializeAuditLogCsv(
        exportEntries,
        {
          time: t('audit.colTime'),
          actor: t('audit.colActor'),
          action: t('audit.colAction'),
          target: t('audit.colTarget'),
          detail: t('audit.colDetail')
        },
        (action) => auditActionLabel(action, t)
      )
      const result = await window.api.invoke('organization:export-audit-log', {
        csv,
        suggestedFileName: t('audit.exportFileName')
      })
      if (result.saved) setExportedEntryCount(exportEntries.length)
    } catch {
      // Keep the timeline intact so the User can retry after a cancelled dialog or local I/O error.
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <section id="audit-log" aria-labelledby="audit-log-heading" className="grid gap-5">
      <div className="grid gap-1">
        <h2 id="audit-log-heading" className="text-base font-semibold">
          {t('audit.title')}
        </h2>
        <p className="text-muted-foreground text-sm">{t('audit.description')}</p>
      </div>
      {verification.status === 'error' ? (
        <div className="grid justify-items-start gap-3">
          <p role="alert" className="text-destructive text-sm">
            {t('audit.accessUnavailable')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            {t('audit.retry')}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger aria-label={t('audit.filterAll')} className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('audit.filterAll')}</SelectItem>
                {Object.entries(actionTranslationKeys).map(([action, translationKey]) => (
                  <SelectItem key={action} value={action}>
                    {t(translationKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" disabled={isExporting} onClick={() => void exportAuditLog()}>
              {t('audit.export')}
            </Button>
            {exportedEntryCount !== undefined ? (
              <p role="status" className="text-muted-foreground text-sm">
                {t('audit.exported', { count: exportedEntryCount })}
              </p>
            ) : null}
          </div>
          <div className="grid gap-6">
            {groups.map((group) => (
              <section
                key={group.date.toISOString()}
                aria-labelledby={`audit-log-day-${group.date.getTime()}`}
              >
                <h3
                  id={`audit-log-day-${group.date.getTime()}`}
                  className="text-muted-foreground mb-2 text-sm font-medium"
                >
                  {formatAuditLogDay(group.date, i18n.language, {
                    today: t('audit.today'),
                    yesterday: t('audit.yesterday')
                  })}
                </h3>
                <ul className="grid gap-2">
                  {group.entries.map((entry) => (
                    <AuditLogTimelineEntry key={entry.id} entry={entry} language={i18n.language} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

type AuditLogAccessVerification =
  | {
      readonly status: 'authorized'
      readonly organizationId: string
      readonly membership: ActiveMembership
    }
  | { readonly status: 'denied' | 'error'; readonly organizationId: string }

function useVerifiedAuditLogOrganization(): {
  readonly verification: AuditLogAccessVerification | undefined
  readonly retry: () => void
} {
  const { activeOrganization, refreshActiveOrganization } = useActiveOrganization()
  const activeOrganizationId = activeOrganization?.organizationId
  const [verification, setVerification] = useState<AuditLogAccessVerification>()
  const [verificationAttempt, setVerificationAttempt] = useState(0)

  useEffect(() => {
    let isMounted = true
    if (!activeOrganizationId) return

    void refreshActiveOrganization()
      .then((membership) => {
        if (!isMounted) return
        setVerification(
          canViewAuditLog(membership)
            ? { status: 'authorized', organizationId: activeOrganizationId, membership }
            : { status: 'denied', organizationId: activeOrganizationId }
        )
      })
      .catch(() => {
        if (isMounted) {
          setVerification({ status: 'error', organizationId: activeOrganizationId })
        }
      })

    return () => {
      isMounted = false
    }
  }, [activeOrganizationId, refreshActiveOrganization, verificationAttempt])

  return {
    verification: verification?.organizationId === activeOrganizationId ? verification : undefined,
    retry: () => {
      setVerification(undefined)
      setVerificationAttempt((attempt) => attempt + 1)
    }
  }
}

function AuditLogTimelineEntry({
  entry,
  language
}: {
  readonly entry: AuditLogEntry
  readonly language: string
}): React.JSX.Element {
  const { t } = useTranslation('organization')
  const action = auditActionLabel(entry.action, t)
  const target = auditLogTargetDisplayName(entry)
  const occurredAt = new Date(entry.createdAt)

  return (
    <li className="bg-card flex flex-wrap items-center gap-x-1.5 rounded-md border px-3 py-2 text-sm">
      <span className="font-medium">{entry.actorDisplayName}</span>
      <span>{action}</span>
      {target ? (
        <>
          <span aria-hidden="true">→</span>
          <span>{target}</span>
        </>
      ) : null}
      <span aria-hidden="true">·</span>
      <time dateTime={entry.createdAt} className="text-muted-foreground">
        {formatAuditLogTime(occurredAt, language)}
      </time>
    </li>
  )
}

function auditActionLabel(action: string, t: ReturnType<typeof useTranslation>['t']): string {
  const translationKey = actionTranslationKey(action)
  return translationKey ? t(translationKey) : action
}
