export interface RememberedActiveOrganization {
  readonly organizationId: string | null
}

export interface SetRememberedActiveOrganizationRequest {
  readonly organizationId: string
}

declare module '@ipc/channels' {
  interface IpcChannelMap {
    'organization:get-remembered-active-organization': { response: RememberedActiveOrganization }
    'organization:set-remembered-active-organization': {
      request: SetRememberedActiveOrganizationRequest
      response: RememberedActiveOrganization
    }
  }
}

export {}
