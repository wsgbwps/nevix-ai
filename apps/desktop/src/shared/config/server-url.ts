/**
 * The structural origin parse and the plain-http destination policy for the
 * server URL a device may connect to (ADR-0014, #153). Https is structurally
 * valid on any host; plain http survives only as a loopback exception on an
 * unpackaged (development) runtime — RFC1918 is no customer exception. The
 * destination policy is enforced exclusively by the main process, which knows
 * the runtime mode (`!app.isPackaged`); the renderer keeps this structural
 * parse for immediate feedback and defers the http verdict to the probe.
 */

/** The hosts a plain-http server URL may target, before the mode check. */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * The runtime plain-http policy (#153): customer deployments accept https
 * only; plain http is reserved for loopback addresses on an explicit
 * development runtime.
 */
export function allowsPlainHttpServerUrl(hostname: string, developmentMode: boolean): boolean {
  return developmentMode && isLoopbackHostname(hostname)
}

/**
 * Parses a server URL into its canonical origin, or `undefined` when the URL
 * is not an exact http(s) origin: no credentials, path, query, or fragment.
 */
export function parseServerUrl(url: string): string | undefined {
  try {
    const parsedUrl = new URL(url)
    if (
      (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') ||
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
