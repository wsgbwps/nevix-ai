import { readServerPublicConfig } from '../../../lib/server-public-config'

interface OrganizationCommandInput {
  readonly accessToken: string
  readonly method: 'POST' | 'PATCH'
  readonly path: string
  readonly body: Readonly<Record<string, unknown>>
}

export class OrganizationCommandError extends Error {
  readonly code: string
  readonly status: number
  readonly retryAfterSeconds: number | undefined

  constructor(code: string, status: number, retryAfterSeconds: number | undefined) {
    super('Organization command failed.')
    this.name = 'OrganizationCommandError'
    this.code = code
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export function isPotentialOrganizationAccessLoss(error: unknown): boolean {
  return error instanceof OrganizationCommandError && (error.status === 403 || error.status === 404)
}

export async function requestOrganizationCommand({
  accessToken,
  method,
  path,
  body
}: OrganizationCommandInput): Promise<unknown> {
  if (accessToken.length === 0) throw new Error('Organization command Session is unavailable.')

  const config = readServerPublicConfig()
  if (!config) throw new Error('Server configuration is unavailable.')

  const response = await fetch(new URL(path, config.url), {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) throw await toOrganizationCommandError(response)

  try {
    return await response.json()
  } catch {
    throw new Error('Organization command response is invalid.')
  }
}

async function toOrganizationCommandError(response: Response): Promise<OrganizationCommandError> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }

  const code =
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    'message' in body &&
    typeof body.error === 'string' &&
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(body.error) &&
    typeof body.message === 'string'
      ? body.error
      : 'organization_command_failed'

  return new OrganizationCommandError(
    code,
    response.status,
    parseRetryAfter(response.headers.get('Retry-After'))
  )
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return undefined

  const seconds = Number(value)
  return Number.isSafeInteger(seconds) ? seconds : undefined
}
