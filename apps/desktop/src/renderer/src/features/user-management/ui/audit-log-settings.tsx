import { useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { DownloadIcon } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import {
  listAuditLogs,
  type AuditLogEntry,
  type AuditLogPage,
  type AuthenticatedManagementSession
} from '../api/client'
import { auditLogExportFileName, serializeAuditLogCsv } from '../lib/audit-log-csv'

export const AUDIT_LOGS_PER_PAGE = 20
/** The export collects every page; 100 is the contract's per_page ceiling. */
const EXPORT_PER_PAGE = 100

type GetSession = () => Promise<AuthenticatedManagementSession | undefined>

type SettingsNavigateSemantics = 'navigable' | 'confirm-discard' | 'blocked'
type SettingsCloseSemantics = 'allow' | 'confirm' | 'defer' | 'deny'

// Structurally mirrors the Settings Flow's SettingsLeaveSemantics contract
// (app/settings); Features do not import across that seam.
export type AuditLogSettingsContribution = {
  readonly navigate: SettingsNavigateSemantics
  readonly close: SettingsCloseSemantics
  readonly discard?: () => void
}

const CLEAN_CONTRIBUTION: AuditLogSettingsContribution = {
  navigate: 'navigable',
  close: 'allow'
}

// While the export runs the file dialog or the collector may hold unsaved work.
const EXPORT_ACTIVE_CONTRIBUTION: AuditLogSettingsContribution = {
  navigate: 'blocked',
  close: 'deny'
}

const AUDIT_ACTION_KEYS = [
  'bootstrap_admin_created',
  'session_created',
  'session_revoked',
  'password_changed',
  'display_name_changed',
  'user_created',
  'user_disabled',
  'user_password_reset',
  'user_email_changed',
  'user_role_changed',
  'user_deleted',
  'join_code_created',
  'join_code_revoked'
] as const

type AuditActionKey = (typeof AUDIT_ACTION_KEYS)[number]

function auditActionLabel(action: string, t: TFunction<'userManagement'>): string {
  return (AUDIT_ACTION_KEYS as readonly string[]).includes(action)
    ? t(`audit.actions.${action as AuditActionKey}`)
    : action
}

export function AuditLogSettings({
  getSession,
  serverUrl,
  onContributionChange
}: {
  readonly getSession: GetSession
  readonly serverUrl: string
  readonly onContributionChange?: (contribution: AuditLogSettingsContribution) => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation('userManagement')
  const [requestedPage, setRequestedPage] = useState(1)
  const [page, setPage] = useState<AuditLogPage>()
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [isExporting, setIsExporting] = useState(false)
  const [exportedCount, setExportedCount] = useState<number>()

  useEffect(() => {
    let isMounted = true

    void (async () => {
      const session = await getSession()
      if (!session) {
        if (isMounted) setLoadState('failed')
        return
      }

      const result = await listAuditLogs(session, serverUrl, {
        page: requestedPage,
        perPage: AUDIT_LOGS_PER_PAGE
      })
      if (!isMounted) return

      if (result.outcome !== 'succeeded') {
        setLoadState('failed')
        return
      }

      setPage(result.value)
      setLoadState('ready')
    })()

    return () => {
      isMounted = false
    }
  }, [getSession, loadAttempt, requestedPage, serverUrl])

  useEffect(() => {
    onContributionChange?.(isExporting ? EXPORT_ACTIVE_CONTRIBUTION : CLEAN_CONTRIBUTION)
  }, [isExporting, onContributionChange])

  useEffect(
    () => () => {
      onContributionChange?.(CLEAN_CONTRIBUTION)
    },
    [onContributionChange]
  )

  async function exportAuditLog(): Promise<void> {
    if (isExporting) return

    setIsExporting(true)
    setExportedCount(undefined)
    try {
      const session = await getSession()
      if (!session) return

      // Collect every page so the file is the complete query result, not just
      // the visible slice.
      const collected: AuditLogEntry[] = []
      for (let pageToCollect = 1; ; pageToCollect += 1) {
        const result = await listAuditLogs(session, serverUrl, {
          page: pageToCollect,
          perPage: EXPORT_PER_PAGE
        })
        if (result.outcome !== 'succeeded') return
        collected.push(...result.value.entries)
        if (collected.length >= result.value.total || result.value.entries.length === 0) break
      }

      const csv = serializeAuditLogCsv(
        collected,
        {
          time: t('audit.colTime'),
          actor: t('audit.colActor'),
          action: t('audit.colAction'),
          target: t('audit.colTarget'),
          metadata: t('audit.colMetadata')
        },
        (action) => auditActionLabel(action, t)
      )
      const result = await window.api.invoke('user-management:export-audit-log', {
        csv,
        suggestedFileName: auditLogExportFileName()
      })
      if (result.saved) setExportedCount(collected.length)
    } catch {
      // A cancelled dialog or local I/O error keeps the visible list intact; the
      // User can retry.
    } finally {
      setIsExporting(false)
    }
  }

  const timestampFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'medium'
  })
  const totalPages = page ? Math.max(1, Math.ceil(page.total / page.perPage)) : 1

  return (
    <section aria-labelledby="audit-log-heading" className="grid gap-5 px-5 py-5">
      <div className="grid gap-1">
        <h2 id="audit-log-heading" className="text-base font-semibold">
          {t('audit.title')}
        </h2>
        <p className="text-muted-foreground text-sm">{t('audit.description')}</p>
      </div>

      {loadState === 'failed' ? (
        <div role="alert" className="bg-destructive/10 grid gap-3 rounded-md p-3 text-sm">
          <p>{t('audit.loadFailed')}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
          >
            {t('audit.retry')}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground text-sm">
              {page !== undefined
                ? t('audit.pagination', {
                    page: page.page,
                    totalPages,
                    total: page.total
                  })
                : ''}
            </p>
            <Button
              type="button"
              disabled={isExporting || page === undefined || page.total === 0}
              onClick={() => void exportAuditLog()}
            >
              <DownloadIcon aria-hidden="true" />
              {t('audit.export')}
            </Button>
          </div>
          {exportedCount !== undefined ? (
            <p role="status" className="text-muted-foreground text-sm">
              {t('audit.exportNotice', { count: exportedCount })}
            </p>
          ) : null}

          {loadState === 'loading' ? (
            <p className="text-muted-foreground py-6 text-center text-sm" role="status">
              {t('audit.loading')}
            </p>
          ) : page === undefined || page.entries.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">{t('audit.empty')}</p>
          ) : (
            <ol aria-label={t('audit.listLabel')} className="divide-y rounded-lg border">
              {page.entries.map((entry) => (
                <li key={entry.id} className="grid gap-1 px-4 py-3">
                  <p className="text-sm font-medium">
                    {auditActionLabel(entry.action, t)}
                    <span className="text-muted-foreground font-normal">
                      {' · '}
                      {entry.targetDisplayName ?? t('audit.noTarget')}
                    </span>
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {timestampFormatter.format(new Date(entry.createdAt))}
                    {' · '}
                    {entry.actorDisplayName}
                  </p>
                </li>
              ))}
            </ol>
          )}

          {page !== undefined ? (
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page.page <= 1 || isExporting}
                onClick={() => setRequestedPage(page.page - 1)}
              >
                {t('audit.previousPage')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page.page >= totalPages || isExporting}
                onClick={() => setRequestedPage(page.page + 1)}
              >
                {t('audit.nextPage')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}
