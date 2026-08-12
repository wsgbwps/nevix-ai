import { ipcMain } from 'electron'
import { exportAuditLogHandler } from './export-audit-log'
import { getRememberedActiveOrganizationHandler } from './get-remembered-active-organization'
import { setRememberedActiveOrganizationHandler } from './set-remembered-active-organization'

export function register(): void {
  ipcMain.handle(
    'organization:get-remembered-active-organization',
    getRememberedActiveOrganizationHandler
  )
  ipcMain.handle(
    'organization:set-remembered-active-organization',
    setRememberedActiveOrganizationHandler
  )
  ipcMain.handle('organization:export-audit-log', exportAuditLogHandler)
}
