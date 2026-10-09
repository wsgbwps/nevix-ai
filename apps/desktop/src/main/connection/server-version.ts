import { net } from 'electron'
import { currentServerConnectionUrl, currentCertificatePins } from './connection-store'
import { probeServerConnection } from './probe'

export interface ServerVersion {
  readonly service: 'nevix-server'
  readonly serverUrl: string
  readonly connectionIdentity: string
  readonly version: string
  readonly min_desktop_version: string
}
export async function readCurrentServerVersion(): Promise<ServerVersion> {
  const url = currentServerConnectionUrl()
  const pins = currentCertificatePins()
  if (!url || (await probeServerConnection(url, pins)).outcome !== 'reachable')
    throw new Error('Server unavailable')
  // Customer traffic stays on the existing connection session and TOFU verifier.
  const response = await net.fetch(new URL('/release/version', url).href, {
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: { Accept: 'application/json' }
  })
  if (response.status !== 200 || !response.body) throw new Error('Server version unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 65536) throw new Error('Oversized server version')
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  if (currentServerConnectionUrl() !== url || currentCertificatePins() !== pins) {
    throw new Error('Server connection changed during version check')
  }
  const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!payload || typeof payload !== 'object') throw new Error('Unknown server version')
  const record = payload as Record<string, unknown>
  if (
    record.service !== 'nevix-server' ||
    typeof record.version !== 'string' ||
    typeof record.min_desktop_version !== 'string'
  )
    throw new Error('Unknown server version')
  return {
    ...record,
    serverUrl: url,
    connectionIdentity: currentServerConnectionIdentity()
  } as unknown as ServerVersion
}

export function currentServerConnectionIdentity(): string {
  const url = currentServerConnectionUrl()
  return url
    ? JSON.stringify([url, currentCertificatePins().get(new URL(url).hostname) ?? null])
    : ''
}
