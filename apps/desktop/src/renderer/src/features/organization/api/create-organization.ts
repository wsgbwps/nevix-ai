import { OrganizationCommandError, requestOrganizationCommand } from './command-client'

export interface CreateOrganizationInput {
  readonly accessToken: string
  readonly id: string
  readonly name: string
}

export interface Organization {
  readonly id: string
  readonly name: string
}

export async function createOrganization({
  accessToken,
  id,
  name
}: CreateOrganizationInput): Promise<Organization> {
  let body: unknown
  try {
    body = await requestOrganizationCommand({
      accessToken,
      method: 'POST',
      path: '/identity/organizations',
      body: { id, name }
    })
  } catch (error) {
    if (error instanceof OrganizationCommandError) {
      throw new Error('Organization request failed.')
    }
    throw error
  }
  if (typeof body !== 'object' || body === null)
    throw new Error('Organization response is invalid.')

  const organization = (body as { organization?: unknown }).organization
  if (typeof organization !== 'object' || organization === null) {
    throw new Error('Organization response is invalid.')
  }

  const result = organization as { id?: unknown; name?: unknown }
  if (result.id !== id || typeof result.name !== 'string') {
    throw new Error('Organization response is invalid.')
  }

  return { id: result.id, name: result.name }
}
