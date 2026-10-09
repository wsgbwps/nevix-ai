import { test, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const testRequire = createRequire(__filename)
const buildRequire = createRequire(testRequire.resolve('electron-vite'))

test('Apple Silicon full ZIP download leaves native staging off until explicit install', async () => {
  test.skip(process.platform !== 'darwin' || process.arch !== 'arm64')
  const root = await mkdtemp(join(tmpdir(), 'nevix-mac-update-'))
  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'nevix-mac-update-check',
        version: '1.0.0',
        main: 'main.cjs'
      })
    )
    await buildRequire('esbuild').build({
      entryPoints: [join(__dirname, 'mac-download-driver.ts')],
      outfile: join(root, 'main.cjs'),
      bundle: true,
      platform: 'node',
      external: ['electron']
    })
    const { stdout } = await promisify(execFile)(testRequire('electron'), [root], {
      timeout: 25000
    })
    expect(stdout).toContain('Mac signed-provider download/native staging boundary passed')
    const lifecycleProbe = await promisify(execFile)(
      testRequire('electron'),
      [root, '--probe-retry-lifecycle'],
      { timeout: 25000 }
    )
    expect(lifecycleProbe.stdout).toContain(
      'Mac retries reuse one listener set without abandoned native proxies'
    )
    const transportProbe = await promisify(execFile)(
      testRequire('electron'),
      [root, '--probe-native-transport'],
      { timeout: 25000 }
    )
    expect(transportProbe.stdout).toContain('Mac verified complete native transport installs once')
    const swappedProbe = await promisify(execFile)(
      testRequire('electron'),
      [root, '--probe-swapped-transport'],
      { timeout: 25000 }
    )
    expect(swappedProbe.stdout).toContain(
      'Mac swapped/restored cache cannot complete native transport'
    )
    const staleProbe = await promisify(execFile)(
      testRequire('electron'),
      [root, '--probe-stale-native-event'],
      { timeout: 25000 }
    )
    expect(staleProbe.stdout).toContain('Mac stale native completion cannot authorize a candidate')
    const timeoutProbe = await promisify(execFile)(
      testRequire('electron'),
      [root, '--probe-stage-timeout'],
      { timeout: 25000 }
    )
    expect(timeoutProbe.stdout).toContain(
      'Mac native staging timeout blocks late installation and retry'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
