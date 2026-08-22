export interface ServerPublicConfig {
  readonly url: string
}

export type ServerPublicConfigPolicy = 'https-only' | 'private-network-http'

interface ServerPublicConfigInput {
  readonly url: string | undefined
  readonly policy: ServerPublicConfigPolicy
}

export function serverPublicConfigPolicyForMode(mode: string): ServerPublicConfigPolicy {
  return mode === 'development' || mode === 'test' ? 'private-network-http' : 'https-only'
}

/** RFC1918, loopback, and nothing else: the hosts a plain-http server URL may target. */
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

export function parseServerPublicConfig({
  url,
  policy
}: ServerPublicConfigInput): ServerPublicConfig | undefined {
  if (!url) return undefined

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

    return { url: parsedUrl.origin }
  } catch {
    return undefined
  }
}
