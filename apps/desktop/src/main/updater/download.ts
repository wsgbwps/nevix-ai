import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import type { Release } from './release-trust'

export async function downloadReleaseArtifact(
  release: Release,
  destination: string,
  signal: AbortSignal,
  fetchArtifact: typeof fetch = fetch
): Promise<void> {
  let url = new URL(release.url)
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Artifact requires HTTPS without credentials')
    const response = await fetchArtifact(url.href, {
      redirect: 'manual',
      credentials: 'omit',
      signal,
      headers: { Accept: 'application/octet-stream' }
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw new Error('Missing artifact redirect')
      url = new URL(location, url)
      continue
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel()
      throw new Error('Artifact download unavailable')
    }
    const reader = response.body.getReader()
    const file = await open(destination, 'w', 0o600)
    try {
      const hash = createHash('sha512')
      let size = 0
      for (;;) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > release.size) throw new Error('Wrong artifact bytes')
        hash.update(value)
        await file.writeFile(value)
      }
      if (size !== release.size || hash.digest('base64') !== release.sha512)
        throw new Error('Wrong artifact bytes')
    } catch (error) {
      await file.close()
      await rm(destination, { force: true })
      throw error
    } finally {
      await file.close()
      await reader.cancel()
    }
    return
  }
  throw new Error('Too many artifact redirects')
}
