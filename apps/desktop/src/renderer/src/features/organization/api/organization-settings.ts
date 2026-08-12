import type { AuthenticatedOrganizationSession } from './client'
import { requestOrganizationCommand } from './command-client'

export async function updateOrganizationSettings(
  session: AuthenticatedOrganizationSession,
  organizationId: string,
  name: string
): Promise<{ readonly id: string; readonly name: string }> {
  const response = await requestOrganizationCommand({
    accessToken: session.accessToken,
    method: 'PATCH',
    path: `/identity/organizations/${encodeURIComponent(organizationId)}/settings`,
    body: { name }
  })

  if (
    typeof response !== 'object' ||
    response === null ||
    !('organization' in response) ||
    typeof response.organization !== 'object' ||
    response.organization === null ||
    !('id' in response.organization) ||
    !('name' in response.organization) ||
    response.organization.id !== organizationId ||
    typeof response.organization.name !== 'string' ||
    response.organization.name.length === 0
  ) {
    throw new Error('Organization settings response is invalid.')
  }

  return { id: response.organization.id, name: response.organization.name }
}
