import { loadRememberedActiveOrganizationId } from '../active-organization-store'
import type { RememberedActiveOrganization } from '../../../shared/ipc/organization/types'

export async function getRememberedActiveOrganizationHandler(): Promise<RememberedActiveOrganization> {
  return { organizationId: await loadRememberedActiveOrganizationId() }
}
