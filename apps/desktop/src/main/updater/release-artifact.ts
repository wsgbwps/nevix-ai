import { createHash } from 'node:crypto'
import { createReadStream, openSync, closeSync, readSync, fstatSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import type { Release } from './release-trust'

interface ArtifactDescription {
  readonly url: string
  readonly size?: number
  readonly sha512: string
}
export function assertUpdaterDescription(
  release: Release,
  info: { readonly version: string; readonly files: readonly ArtifactDescription[] },
  files: readonly {
    readonly url: URL
    readonly info: ArtifactDescription
    readonly packageInfo?: unknown
  }[]
): void {
  if (info.version !== release.version || info.files.length !== 1 || files.length !== 1)
    throw new Error('Updater description does not match signed release')
  for (const file of [info.files[0], files[0].info])
    if (file.url !== release.url || file.size !== release.size || file.sha512 !== release.sha512)
      throw new Error('Updater description does not match signed release')
  if (files[0].url.href !== new URL(release.url).href || files[0].packageInfo !== undefined)
    throw new Error('Updater description does not match signed release')
}
export async function verifyArtifact(release: Release, path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size !== release.size) throw new Error('Wrong artifact bytes')
  const hash = createHash('sha512')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    size += chunk.length
    hash.update(chunk)
  }
  if (size !== release.size || hash.digest('base64') !== release.sha512)
    throw new Error('Wrong artifact bytes')
}
// Final synchronous verification leaves no event-loop gap before invoking the installer.
export function verifyArtifactSync(release: Release, path: string): void {
  const fd = openSync(path, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size !== release.size) throw new Error('Wrong artifact bytes')
    const hash = createHash('sha512'),
      buffer = Buffer.alloc(1024 * 1024)
    let size = 0,
      length: number
    while ((length = readSync(fd, buffer)) > 0) {
      size += length
      hash.update(buffer.subarray(0, length))
    }
    if (size !== release.size || hash.digest('base64') !== release.sha512)
      throw new Error('Wrong artifact bytes')
  } finally {
    closeSync(fd)
  }
}
