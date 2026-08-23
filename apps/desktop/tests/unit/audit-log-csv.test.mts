import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isDesktopSource = context.parentURL?.includes('/apps/desktop/src/') === true
    const resolvedSpecifier =
      isDesktopSource && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)
        ? `${specifier}.ts`
        : specifier
    return nextResolve(resolvedSpecifier, context)
  }
})

const { auditLogExportFileName, serializeAuditLogCsv } =
  await import('../../src/renderer/src/features/user-management/lib/audit-log-csv.ts')
type AuditLogEntry =
  import('../../src/renderer/src/features/user-management/api/client.ts').AuditLogEntry

function entry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: 'entry-1',
    action: 'user_created',
    actorUserId: 'user-1',
    actorDisplayName: 'Admin',
    targetUserId: 'user-2',
    targetDisplayName: 'Member',
    metadata: { email: 'member@example.com' },
    createdAt: '2026-08-23T10:05:00Z',
    ...overrides
  }
}

test('audit entries serialize as a CRLF CSV with the translated header row', () => {
  const csv = serializeAuditLogCsv(
    [entry(), entry({ id: 'entry-2', targetUserId: null, targetDisplayName: null, metadata: {} })],
    { time: '时间', actor: '操作者', action: '动作', target: '对象', metadata: '详情' },
    (action) => `action:${action}`
  )

  const lines = csv.split('\r\n')
  assert.equal(lines[0], '时间,操作者,动作,对象,详情')
  assert.equal(
    lines[1],
    '2026-08-23T10:05:00Z,Admin,action:user_created,Member,"{""email"":""member@example.com""}"'
  )
  assert.equal(lines[2], '2026-08-23T10:05:00Z,Admin,action:user_created,,{}')
  assert.equal(lines[3], '')
  assert.ok(csv.endsWith('\r\n'))
})

test('spreadsheet formulas and separators are escaped in every cell', () => {
  const csv = serializeAuditLogCsv(
    [entry({ actorDisplayName: '=SUM(A1:A2)', targetDisplayName: 'a,b"c' })],
    { time: 'time', actor: 'actor', action: 'action', target: 'target', metadata: 'detail' },
    (action) => action
  )

  const lines = csv.split('\r\n')
  assert.equal(
    lines[1],
    '2026-08-23T10:05:00Z,\'=SUM(A1:A2),user_created,"a,b""c","{""email"":""member@example.com""}"'
  )
})

test('the export file name carries the product prefix and a sortable local timestamp', () => {
  const name = auditLogExportFileName(new Date(2026, 7, 23, 15, 4, 9))
  assert.equal(name, 'nevix-audit-log-20260823-150409.csv')

  const fallbackName = auditLogExportFileName()
  assert.match(fallbackName, /^nevix-audit-log-\d{8}-\d{6}\.csv$/)
})
