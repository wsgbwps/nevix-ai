import { readServerPublicConfig } from '../../../lib/server-public-config'

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
  const config = readServerPublicConfig()
  if (!config) throw new Error('Server configuration is unavailable.')

  const response = await fetch(new URL('/identity/organizations', config.url), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ id, name })
  })

  if (!response.ok) throw new Error('Organization request failed.')

  const body: unknown = await response.json()
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
