export interface RememberedActiveOrganization {
  readonly organizationId: string | null
}

export interface SetRememberedActiveOrganizationRequest {
  readonly organizationId: string
}

export interface AuditLogExportRequest {
  readonly csv: string
  readonly suggestedFileName: string
}

export interface AuditLogExportResult {
  readonly saved: boolean
}

declare module '@ipc/channels' {
  interface IpcChannelMap {
    'organization:get-remembered-active-organization': { response: RememberedActiveOrganization }
    'organization:set-remembered-active-organization': {
      request: SetRememberedActiveOrganizationRequest
      response: RememberedActiveOrganization
    }
    'organization:export-audit-log': {
      request: AuditLogExportRequest
      response: AuditLogExportResult
    }
  }
}

export {}
