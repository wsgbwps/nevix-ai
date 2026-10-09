export const RELEASE_PUBLIC_KEY_PEM = ''
export const OFFICIAL_RELEASE_BASE_URL =
  'https://cnb.cool/nevix.ai/nevix-releases/-/git/raw/main/stable/'
export async function readOfficialRelease(
  platform: string,
  arch: string,
  fetchRelease: typeof fetch = fetch
): Promise<unknown> {
  if (!['win32/x64', 'darwin/arm64', 'linux/amd64'].includes(`${platform}/${arch}`))
    throw new Error('Unsupported update target')
  // Node HTTPS uses system trust, never the customer Electron session's TOFU pins.
  const response = await fetchRelease(`${OFFICIAL_RELEASE_BASE_URL}${platform}-${arch}.json`, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: { Accept: 'application/json' }
  })
  if (response.status !== 200 || !response.body) throw new Error('Release source unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 65536) throw new Error('Oversized release envelope')
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid release envelope')
  const record = value as Record<string, unknown>
  // Fixed envelope order rejects duplicate JSON fields before verification.
  if (
    JSON.stringify({
      format: record.format,
      payload: record.payload,
      signature: record.signature
    }) !== text.trim()
  )
    throw new Error('Noncanonical release envelope')
  return value
}
