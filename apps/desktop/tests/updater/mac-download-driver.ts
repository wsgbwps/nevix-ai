import assert from 'node:assert/strict'
import { app, autoUpdater } from 'electron'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { getAppCacheDir } from 'electron-updater/out/AppAdapter'
import { createDesktopUpdater } from '../../src/main/updater/signed-provider'
import { downloadTrustedUpdate, stageNativeUpdate } from '../../src/main/updater/signed-provider'

async function main(): Promise<void> {
  assert.equal(process.platform, 'darwin')
  assert.equal(process.arch, 'arm64')
  await mkdir(join(app.getAppPath(), 'user-data'), { recursive: true })
  app.setPath('userData', join(app.getAppPath(), 'user-data'))
  await app.whenReady()
  let nativeChecks = 0
  let nativeInstalls = 0
  autoUpdater.quitAndInstall = () => {
    nativeInstalls++
  }
  autoUpdater.setFeedURL = () => undefined
  autoUpdater.checkForUpdates = () => {
    nativeChecks++
  }
  const bytes = Buffer.from('verified ZIP transport probe; never sent to Squirrel')
  globalThis.fetch = async () => new Response(bytes)
  await writeFile(
    join(app.getAppPath(), 'dev-app-update.yml'),
    JSON.stringify({
      updaterCacheDirName: relative(getAppCacheDir(), join(app.getAppPath(), 'cache')),
      provider: 'generic',
      url: 'https://example.invalid/'
    })
  )
  const update = await downloadTrustedUpdate(
    {
      version: '1.0.1',
      channel: 'stable',
      platform: 'darwin',
      arch: 'arm64',
      min_server_version: '1.0.0',
      min_desktop_version: '1.0.0',
      url: 'https://example.invalid/Nevix-1.0.1-arm64.zip',
      size: bytes.length,
      sha512: createHash('sha512').update(bytes).digest('base64')
    },
    (release) => {
      const updater = createDesktopUpdater(release)
      updater.forceDevUpdateConfig = true
      return updater
    }
  )
  assert.equal(nativeChecks, 0, 'download must not stage a native Squirrel update')
  assert.equal(update.updater.autoInstallOnAppQuit, false)
  assert.ok(update.path.endsWith('.zip'))
  if (process.argv.includes('--probe-stage-timeout')) {
    const setTimer = globalThis.setTimeout
    globalThis.setTimeout = ((callback, delay, ...args) =>
      setTimer(callback, delay === 45000 ? 10 : delay, ...args)) as typeof setTimeout
    await assert.rejects(stageNativeUpdate(update, new AbortController().signal), /timed out/)
    await assert.rejects(
      stageNativeUpdate(update, new AbortController().signal),
      /Restart required/
    )
    assert.equal(nativeChecks, 1)
    assert.equal(nativeInstalls, 0)
    process.stdout.write('Mac native staging timeout blocks late installation and retry\n')
    app.quit()
    return
  }
  const cancellation = new AbortController()
  const cancelledStage = stageNativeUpdate(update, cancellation.signal)
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  assert.equal(nativeChecks, 1)
  cancellation.abort()
  let drained = false
  const rejected = assert.rejects(cancelledStage).then(() => {
    drained = true
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  assert.equal(drained, false, 'cancelled native staging must drain before another operation')
  autoUpdater.emit('update-downloaded')
  await rejected
  assert.equal(nativeInstalls, 0)
  const stage = stageNativeUpdate(update, new AbortController().signal)
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  assert.equal(nativeChecks, 2)
  autoUpdater.emit('update-downloaded')
  await stage
  update.updater.quitAndInstall(false, true)
  assert.equal(nativeChecks, 2, 'approved install must use the completed native staging')
  assert.equal(nativeInstalls, 1)
  const failedStage = stageNativeUpdate(update, new AbortController().signal)
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  autoUpdater.emit('error', new Error('Signature mismatch'))
  await assert.rejects(failedStage, /Signature mismatch/)
  await assert.rejects(stageNativeUpdate(update, new AbortController().signal), /Restart required/)
  assert.equal(
    nativeChecks,
    3,
    'failed native staging cannot consume a stale event in a later attempt'
  )
  process.stdout.write('Mac signed-provider download/native staging boundary passed\n')
  app.quit()
}
void main().catch((error) => {
  process.stderr.write(String(error))
  app.exit(1)
})
