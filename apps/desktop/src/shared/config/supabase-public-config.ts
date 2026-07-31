export interface SupabasePublicConfig {
  readonly url: string
  readonly publishableKey: string
}

export type SupabasePublicConfigPolicy = 'https-only' | 'private-network-http'

interface SupabasePublicConfigInput {
  readonly url: string | undefined
  readonly publishableKey: string | undefined
  readonly policy: SupabasePublicConfigPolicy
}

const PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9_-]{20,}$/

export function supabasePublicConfigPolicyForMode(mode: string): SupabasePublicConfigPolicy {
  return mode === 'development' || mode === 'test' ? 'private-network-http' : 'https-only'
}

export function isAllowedPrivateHttpHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return true

  const octets = hostname.split('.').map(Number)
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false
  }

  const [first, second] = octets
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  )
}

export function parseSupabasePublicConfig({
  url,
  publishableKey,
  policy
}: SupabasePublicConfigInput): SupabasePublicConfig | undefined {
  if (!url || !publishableKey || !PUBLISHABLE_KEY_PATTERN.test(publishableKey)) return undefined

  try {
    const parsedUrl = new URL(url)
    const isSecure = parsedUrl.protocol === 'https:'
    const isAllowedPrivateHttp =
      policy === 'private-network-http' &&
      parsedUrl.protocol === 'http:' &&
      isAllowedPrivateHttpHostname(parsedUrl.hostname)

    if (
      (!isSecure && !isAllowedPrivateHttp) ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.pathname !== '/' ||
      parsedUrl.search ||
      parsedUrl.hash
    ) {
      return undefined
    }

    return {
      url: parsedUrl.origin,
      publishableKey
    }
  } catch {
    return undefined
  }
}
