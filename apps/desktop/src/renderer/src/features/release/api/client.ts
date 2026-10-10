export interface ReleaseStatus {
  readonly version: string
  readonly min_desktop_version: string
  readonly outcome:
    | 'not-checked'
    | 'trust-unconfigured'
    | 'unknown-version'
    | 'current'
    | 'available'
    | 'incompatible'
    | 'network-failure'
    | 'invalid-release'
  readonly checked_at: string | null
  readonly candidate: null | {
    readonly version: string
    readonly min_server_version: string
    readonly min_desktop_version: string
    readonly compatible: boolean
  }
}

const outcomes: readonly string[] = [
  'not-checked',
  'trust-unconfigured',
  'unknown-version',
  'current',
  'available',
  'incompatible',
  'network-failure',
  'invalid-release'
]

export async function requestReleaseStatus(
  token: string,
  serverUrl: string,
  check: boolean,
  signal: AbortSignal
): Promise<ReleaseStatus | undefined> {
  try {
    const response = await fetch(new URL(check ? '/release/check' : '/release/status', serverUrl), {
      method: check ? 'POST' : 'GET',
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    })
    if (!response.ok) return undefined
    const value = (await response.json()) as ReleaseStatus
    if (
      typeof value.version !== 'string' ||
      typeof value.min_desktop_version !== 'string' ||
      !outcomes.includes(value.outcome) ||
      (value.checked_at !== null && typeof value.checked_at !== 'string')
    )
      return undefined
    if (
      value.candidate !== null &&
      (typeof value.candidate?.version !== 'string' ||
        typeof value.candidate.min_server_version !== 'string' ||
        typeof value.candidate.min_desktop_version !== 'string' ||
        typeof value.candidate.compatible !== 'boolean')
    )
      return undefined
    return value
  } catch {
    return undefined
  }
}
