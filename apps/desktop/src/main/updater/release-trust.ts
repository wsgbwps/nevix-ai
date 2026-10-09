import { createPublicKey, verify } from 'node:crypto'
export interface Release {
  readonly version: string
  readonly channel: 'stable'
  readonly platform: string
  readonly arch: string
  readonly min_server_version: string
  readonly min_desktop_version: string
  readonly url: string
  readonly size: number
  readonly sha512: string
}
const fields = [
  'version',
  'channel',
  'platform',
  'arch',
  'min_server_version',
  'min_desktop_version',
  'url',
  'size',
  'sha512'
] as const
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => {
    if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value))
      throw new Error('Unknown stable version')
    const parts = value.split('.').map(Number)
    if (parts.some((part) => part > 2147483647)) throw new Error('Invalid stable version')
    return parts
  }
  const a = parse(left),
    b = parse(right)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  return 0
}
function exactFields(
  value: unknown,
  names: readonly string[]
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...names].sort().join(',')
  )
    throw new Error('Invalid release fields')
}
function base64(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string') throw new Error('Invalid base64')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length))
    throw new Error('Invalid base64')
  return bytes
}
export function verifyRelease(
  envelope: unknown,
  publicKeyPem: string,
  platform: string,
  arch: string
): Readonly<Release> {
  if (!publicKeyPem) throw new Error('Release trust is not configured')
  exactFields(envelope, ['format', 'payload', 'signature'])
  if (envelope.format !== 'nevix-release-v1') throw new Error('Unknown release identity')
  const bytes = base64(envelope.payload)
  if (bytes.length > 64 * 1024) throw new Error('Oversized release')
  const key = createPublicKey(publicKeyPem)
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    key.export({ type: 'spki', format: 'pem' }).toString().trim() !== publicKeyPem.trim() ||
    !verify(null, bytes, key, base64(envelope.signature, 64))
  )
    throw new Error('Invalid release signature')
  const payload: unknown = JSON.parse(bytes.toString('utf8'))
  exactFields(payload, fields)
  const canonical = Object.fromEntries(fields.map((field) => [field, payload[field]]))
  if (
    !Buffer.from(JSON.stringify(canonical)).equals(bytes) ||
    !/^[\x20-\x7e]+$/.test(bytes.toString('utf8')) ||
    bytes.includes(92)
  )
    throw new Error('Noncanonical release JSON')
  for (const field of fields.filter((field) => field !== 'size'))
    if (typeof payload[field] !== 'string') throw new Error('Invalid release field type')
  if (
    payload.channel !== 'stable' ||
    payload.platform !== platform ||
    payload.arch !== arch ||
    !['win32/x64', 'darwin/arm64', 'linux/amd64'].includes(`${platform}/${arch}`)
  )
    throw new Error('Wrong release target')
  const release = payload as unknown as Release
  for (const version of [release.version, release.min_server_version, release.min_desktop_version])
    compareVersions(version, '0.0.0')
  const authority = /^https:\/\/([^/?#]+)/.exec(release.url)?.[1]
  if (
    !authority ||
    authority.includes('@') ||
    authority.includes('%') ||
    /%(?![0-9a-fA-F]{2})/.test(release.url)
  )
    throw new Error('Invalid artifact URL grammar')
  const url = new URL(release.url)
  const suffix = platform === 'win32' ? '.exe' : platform === 'darwin' ? '.zip' : '.tar.gz'
  if (
    url.protocol !== 'https:' ||
    !release.url.startsWith('https://') ||
    !url.hostname ||
    url.username ||
    url.password ||
    release.url.includes('#') ||
    !(url.pathname.endsWith(suffix) || (platform === 'darwin' && url.pathname.endsWith('.dmg'))) ||
    !Number.isSafeInteger(release.size) ||
    release.size <= 0
  )
    throw new Error('Invalid artifact description')
  base64(release.sha512, 64)
  return Object.freeze(release)
}

export type UpdateCheckResult =
  | { readonly outcome: 'current' }
  | { readonly outcome: 'available'; readonly release: Release }
  | { readonly outcome: 'server-upgrade-required'; readonly minimum: string }
  | { readonly outcome: 'desktop-upgrade-required'; readonly minimum: string }
  | { readonly outcome: 'server-unavailable' }
  | { readonly outcome: 'failed' }
  | { readonly outcome: 'trust-unconfigured' }
export interface UpdateCheckContext {
  readonly currentVersion: string
  readonly platform: string
  readonly arch: string
  readonly publicKeyPem: string
  readonly readRelease: () => Promise<unknown>
  readonly readServer: () => Promise<{
    readonly service: string
    readonly version: string
    readonly min_desktop_version: string
  }>
}
export async function checkForRelease(context: UpdateCheckContext): Promise<UpdateCheckResult> {
  let server: Awaited<ReturnType<UpdateCheckContext['readServer']>>
  try {
    server = await context.readServer()
    if (server.service !== 'nevix-server') return { outcome: 'server-unavailable' }
    compareVersions(server.version, '0.0.0')
    compareVersions(server.min_desktop_version, '0.0.0')
  } catch {
    return { outcome: 'server-unavailable' }
  }
  try {
    if (compareVersions(context.currentVersion, server.min_desktop_version) < 0)
      return { outcome: 'desktop-upgrade-required', minimum: server.min_desktop_version }
    if (!context.publicKeyPem) return { outcome: 'trust-unconfigured' }
    const release = verifyRelease(
      await context.readRelease(),
      context.publicKeyPem,
      context.platform,
      context.arch
    )
    if (context.platform === 'darwin' && !new URL(release.url).pathname.endsWith('.zip'))
      throw new Error('Wrong update artifact')
    if (compareVersions(release.version, context.currentVersion) <= 0) return { outcome: 'current' }
    if (compareVersions(server.version, release.min_server_version) < 0)
      return { outcome: 'server-upgrade-required', minimum: release.min_server_version }
    if (compareVersions(release.version, server.min_desktop_version) < 0)
      return { outcome: 'desktop-upgrade-required', minimum: server.min_desktop_version }
    return { outcome: 'available', release }
  } catch {
    return { outcome: 'failed' }
  }
}
