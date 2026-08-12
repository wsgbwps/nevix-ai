import type { AuditLogEntry } from '../api/audit-logs'
import { auditLogTargetDisplayName } from './audit-log-target'

export interface AuditLogCsvColumns {
  readonly time: string
  readonly actor: string
  readonly action: string
  readonly target: string
  readonly detail: string
}

export function serializeAuditLogCsv(
  entries: readonly AuditLogEntry[],
  columns: AuditLogCsvColumns,
  actionLabel: (action: string) => string
): string {
  const rows = [
    [columns.time, columns.actor, columns.action, columns.target, columns.detail],
    ...entries.map((entry) => [
      entry.createdAt,
      entry.actorDisplayName,
      actionLabel(entry.action),
      auditLogTargetDisplayName(entry) ?? '',
      JSON.stringify(entry.metadata)
    ])
  ]

  return `${rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n')}\r\n`
}

function escapeCsvCell(value: string): string {
  const safeValue = protectSpreadsheetFormula(value)
  return /[",\r\n]/.test(safeValue) ? `"${safeValue.replaceAll('"', '""')}"` : safeValue
}

function protectSpreadsheetFormula(value: string): string {
  return /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value
}
