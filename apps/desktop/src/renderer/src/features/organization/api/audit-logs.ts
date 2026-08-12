import { createOrganizationDataClient, type AuthenticatedOrganizationSession } from './client'

const AUDIT_LOG_PAGE_SIZE = 100

interface AuditLogCursor {
  readonly createdAt: string
  readonly id: string
}

export interface AuditLogEntry {
  readonly id: string
  readonly actorDisplayName: string
  readonly targetDisplayName: string | null
  readonly action: string
  readonly metadata: Readonly<Record<string, unknown>>
  readonly createdAt: string
}

/**
 * Reads every visible Audit Log page through the Data API. RLS remains the authority for whether
 * the current Session can see a row; the renderer only supplies the selected Organization scope.
 */
export async function readAuditLogEntries(
  session: AuthenticatedOrganizationSession,
  organizationId: string,
  action?: string
): Promise<readonly AuditLogEntry[]> {
  const entries: AuditLogEntry[] = []
  const client = createOrganizationDataClient(session)
  let cursor: AuditLogCursor | undefined

  while (true) {
    let query = client
      .from('audit_logs')
      .select('id, actor_display_name, target_display_name, action, metadata, created_at')
      .eq('organization_id', organizationId)
    if (action) query = query.eq('action', action)
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
      )
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(AUDIT_LOG_PAGE_SIZE)

    if (error) throw new Error('Audit Log request failed.')
    if (!Array.isArray(data)) throw new Error('Audit Log response is invalid.')

    const page = data.map(toAuditLogEntry)
    entries.push(...page)
    if (page.length < AUDIT_LOG_PAGE_SIZE) return entries

    const cursorEntry = page.at(-1)
    if (!cursorEntry) return entries
    cursor = { createdAt: cursorEntry.createdAt, id: cursorEntry.id }
  }
}

function toAuditLogEntry(value: unknown): AuditLogEntry {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Audit Log response is invalid.')
  }

  const row = value as {
    id?: unknown
    actor_display_name?: unknown
    target_display_name?: unknown
    action?: unknown
    metadata?: unknown
    created_at?: unknown
  }
  if (
    typeof row.id !== 'string' ||
    typeof row.actor_display_name !== 'string' ||
    (row.target_display_name !== null && typeof row.target_display_name !== 'string') ||
    typeof row.action !== 'string' ||
    typeof row.metadata !== 'object' ||
    row.metadata === null ||
    Array.isArray(row.metadata) ||
    typeof row.created_at !== 'string' ||
    Number.isNaN(Date.parse(row.created_at))
  ) {
    throw new Error('Audit Log response is invalid.')
  }

  return {
    id: row.id,
    actorDisplayName: row.actor_display_name,
    targetDisplayName: row.target_display_name,
    action: row.action,
    metadata: row.metadata as Readonly<Record<string, unknown>>,
    createdAt: row.created_at
  }
}
