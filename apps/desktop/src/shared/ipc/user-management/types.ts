export interface AuditLogExportRequest {
  readonly csv: string
  readonly suggestedFileName: string
}

export interface AuditLogExportResult {
  readonly saved: boolean
}

declare module '@ipc/channels' {
  interface IpcChannelMap {
    'user-management:export-audit-log': {
      request: AuditLogExportRequest
      response: AuditLogExportResult
    }
  }
}

export {}
