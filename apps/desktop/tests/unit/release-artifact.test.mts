import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertUpdaterDescription,
  verifyArtifact,
  verifyArtifactSync
} from '../../src/main/updater/release-artifact.ts'
import type { Release } from '../../src/main/updater/release-trust.ts'

const bytes = Buffer.from('signed installer bytes A')
const release: Release = Object.freeze({
  version: '1.0.1',
  channel: 'stable',
  platform: 'win32',
  arch: 'x64',
  min_server_version: '1.0.0',
  min_desktop_version: '1.0.0',
  url: 'https://example.com/a.exe',
  size: bytes.length,
  sha512: createHash('sha512').update(bytes).digest('base64')
})

test('signed artifact binding refuses descriptor substitutions and actual replaced cache bytes', async () => {
  const file = { url: release.url, size: release.size, sha512: release.sha512 }
  const info = { version: release.version, files: [file] }
  assertUpdaterDescription(release, info, [{ url: new URL(file.url), info: file }])
  for (const change of [
    { version: '1.0.2' },
    { files: [{ ...file, url: 'https://example.com/b.exe' }] },
    { files: [{ ...file, size: 100 }] },
    { files: [{ ...file, sha512: 'other' }] }
  ])
    assert.throws(() =>
      assertUpdaterDescription(release, { ...info, ...change }, [
        { url: new URL(file.url), info: file }
      ])
    )
  const dir = await mkdtemp(join(tmpdir(), 'nevix-cache-'))
  try {
    const path = join(dir, 'update.exe')
    await writeFile(path, bytes)
    await verifyArtifact(release, path)
    verifyArtifactSync(release, path)
    await writeFile(path, Buffer.from('replaced installer B!!!'))
    await assert.rejects(verifyArtifact(release, path))
    assert.throws(() => verifyArtifactSync(release, path))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

import { downloadReleaseArtifact } from '../../src/main/updater/download.ts'
test('a signed full download follows HTTPS redirects but refuses downgrade and substituted bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nevix-download-'))
  const requests: string[] = []
  try {
    const path = join(dir, 'download.exe')
    await downloadReleaseArtifact(release, path, new AbortController().signal, async (url) => {
      requests.push(String(url))
      return requests.length === 1
        ? new Response(null, {
            status: 302,
            headers: { Location: 'https://cdn.example.com/a.exe' }
          })
        : new Response(bytes)
    })
    await verifyArtifact(release, path)
    assert.deepEqual(requests, [release.url, 'https://cdn.example.com/a.exe'])
    let calls = 0
    await assert.rejects(
      downloadReleaseArtifact(release, path, new AbortController().signal, async () => {
        calls++
        return new Response(null, {
          status: 302,
          headers: { Location: 'http://evil.example.com/a.exe' }
        })
      }),
      /HTTPS/
    )
    assert.equal(calls, 1)
    await assert.rejects(
      downloadReleaseArtifact(
        release,
        path,
        new AbortController().signal,
        async () => new Response(Buffer.from('other installer'))
      ),
      /bytes/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
