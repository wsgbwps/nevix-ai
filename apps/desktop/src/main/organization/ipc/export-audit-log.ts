import { app, dialog, BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type {
  AuditLogExportRequest,
  AuditLogExportResult
} from '../../../shared/ipc/organization/types'
import {
  resolveAuditLogE2ECancelDelay,
  resolveAuditLogE2EOutputPath
} from './audit-log-export-path'
import { requireTrustedTopLevelRendererSender } from '../../window/trusted-renderer-sender'

function validateRequest(request: unknown): AuditLogExportRequest {
  const keys = typeof request === 'object' && request !== null ? Object.keys(request) : []
  const value = request as { csv?: unknown; suggestedFileName?: unknown }
  if (
    keys.length !== 2 ||
    typeof value.csv !== 'string' ||
    value.csv.length === 0 ||
    typeof value.suggestedFileName !== 'string' ||
    value.suggestedFileName.length === 0 ||
    value.suggestedFileName !== basename(value.suggestedFileName) ||
    !value.suggestedFileName.endsWith('.csv')
  ) {
    throw new Error('Audit Log export received an invalid file payload')
  }
  return { csv: value.csv, suggestedFileName: value.suggestedFileName }
}

export async function exportAuditLogHandler(
  event: Electron.IpcMainInvokeEvent,
  request: unknown
): Promise<AuditLogExportResult> {
  requireTrustedTopLevelRendererSender(
    event,
    'Audit Log export is available only to the trusted renderer'
  )
  const { csv, suggestedFileName } = validateRequest(request)
  const outputPath = resolveAuditLogE2EOutputPath({
    e2eMode: process.env.NEVIX_E2E,
    isPackaged: app.isPackaged,
    configuredOutputPath: process.env.NEVIX_TEST_AUDIT_LOG_EXPORT_PATH
  })
  const e2eCancelDelayMs = resolveAuditLogE2ECancelDelay({
    e2eMode: process.env.NEVIX_E2E,
    isPackaged: app.isPackaged,
    configuredDelayMs: process.env.NEVIX_TEST_AUDIT_LOG_CANCEL_DELAY_MS
  })
  if (e2eCancelDelayMs !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, e2eCancelDelayMs))
    return { saved: false }
  }

  if (outputPath) {
    await writeFile(outputPath, csv, 'utf8')
    return { saved: true }
  }

  const ownerWindow = BrowserWindow.fromWebContents(event.sender)
  if (!ownerWindow) throw new Error('Audit Log export has no owning window')

  const saveDialog = await dialog.showSaveDialog(ownerWindow, {
    defaultPath: suggestedFileName,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation']
  })
  if (saveDialog.canceled || !saveDialog.filePath) return { saved: false }

  await writeFile(saveDialog.filePath, csv, 'utf8')
  return { saved: true }
}
