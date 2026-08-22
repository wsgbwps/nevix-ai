/**
 * The single runtime policy for the server URL a device may connect to
 * (ADR-0014): https is valid on any host; plain http is reserved for
 * loopback and RFC1918 intranet hosts. Build-time URL injection and its
 * per-mode policy are gone — this validation guards both the persisted
 * connection store and the Connection Screen input.
 */

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

/**
 * Parses a server URL into its canonical origin, or `undefined` when the URL
 * is not an exact server origin under the runtime policy: no credentials,
 * path, query, or fragment, https anywhere, http only on private hosts.
 */
export function parseServerUrl(url: string): string | undefined {
  try {
    const parsedUrl = new URL(url)
    const isSecure = parsedUrl.protocol === 'https:'
    const isAllowedPrivateHttp =
      parsedUrl.protocol === 'http:' && isAllowedPrivateHttpHostname(parsedUrl.hostname)

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

    return parsedUrl.origin
  } catch {
    return undefined
  }
}
