import { readServerPublicConfig } from '../../../lib/server-public-config'

interface OrganizationCommandInput {
  readonly accessToken: string
  readonly method: 'POST' | 'PATCH'
  readonly path: string
  readonly body: Readonly<Record<string, unknown>>
  readonly captureErrorHeaders?: readonly string[]
  readonly signal?: AbortSignal
}

export class OrganizationCommandError extends Error {
  readonly code: string
  readonly status: number
  readonly retryAfterSeconds: number | undefined
  readonly serverMessage: string | undefined
  readonly capturedHeaders: Readonly<Record<string, string>>

  constructor(
    code: string,
    status: number,
    retryAfterSeconds: number | undefined,
    serverMessage: string | undefined,
    capturedHeaders: Readonly<Record<string, string>>
  ) {
    super('Organization command failed.')
    this.name = 'OrganizationCommandError'
    this.code = code
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
    this.serverMessage = serverMessage
    this.capturedHeaders = capturedHeaders
  }
}

export function isPotentialOrganizationAccessLoss(error: unknown): boolean {
  return error instanceof OrganizationCommandError && (error.status === 403 || error.status === 404)
}

export async function requestOrganizationCommand({
  accessToken,
  method,
  path,
  body,
  captureErrorHeaders = [],
  signal
}: OrganizationCommandInput): Promise<unknown> {
  if (accessToken.length === 0) throw new Error('Organization command Session is unavailable.')

  const config = readServerPublicConfig()
  if (!config) throw new Error('Server configuration is unavailable.')

  const response = await fetch(new URL(path, config.url), {
    method,
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal
  })

  if (!response.ok) {
    throw await toOrganizationCommandError(response, captureErrorHeaders)
  }

  try {
    return await response.json()
  } catch {
    throw new Error('Organization command response is invalid.')
  }
}

async function toOrganizationCommandError(
  response: Response,
  captureErrorHeaders: readonly string[]
): Promise<OrganizationCommandError> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }

  const errorEnvelope =
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    'message' in body &&
    typeof body.error === 'string' &&
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(body.error) &&
    typeof body.message === 'string'
      ? { code: body.error, message: body.message }
      : undefined

  return new OrganizationCommandError(
    errorEnvelope?.code ?? 'organization_command_failed',
    response.status,
    parseRetryAfter(response.headers.get('Retry-After')),
    errorEnvelope?.message,
    captureResponseHeaders(response.headers, captureErrorHeaders)
  )
}

function captureResponseHeaders(
  headers: Headers,
  names: readonly string[]
): Readonly<Record<string, string>> {
  const capturedHeaders: Record<string, string> = {}
  for (const name of names) {
    const value = headers.get(name)
    if (value !== null) capturedHeaders[name.toLowerCase()] = value
  }
  return Object.freeze(capturedHeaders)
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return undefined

  const seconds = Number(value)
  return Number.isSafeInteger(seconds) ? seconds : undefined
}
