import { isAllowedPrivateHttpHostname } from './supabase-public-config'

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
