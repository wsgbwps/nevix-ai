import assert from 'node:assert/strict'
import { app, autoUpdater } from 'electron'
import { createHash } from 'node:crypto'
import { get } from 'node:http'
import { verifyArtifact } from '../../src/main/updater/release-artifact'
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
  let nativeFeed = ''
  let nativeHeaders: Record<string, string> = {}
  autoUpdater.setFeedURL = (options) => {
    nativeFeed = typeof options === 'string' ? options : options.url
    nativeHeaders = typeof options === 'string' ? {} : (options.headers ?? {})
  }
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
  if (process.argv.includes('--probe-retry-lifecycle')) {
    assert.equal(nativeFeed, '', 'background download must not create a native proxy/feed')
    const counts = [
      autoUpdater.listenerCount('error'),
      autoUpdater.listenerCount('update-downloaded')
    ]
    for (let i = 0; i < 5; i++) {
      const release = {
        ...update.release,
        version: `1.0.${i + 2}`,
        url: `https://example.invalid/failed-${i}-arm64.zip`,
        sha512: createHash('sha512').update(Buffer.alloc(bytes.length, 67)).digest('base64')
      }
      assert.equal(createDesktopUpdater(release), update.updater)
      globalThis.fetch = async () => new Response(Buffer.alloc(bytes.length, 66))
      await assert.rejects(downloadTrustedUpdate(release), /bytes/)
      assert.deepEqual(
        [autoUpdater.listenerCount('error'), autoUpdater.listenerCount('update-downloaded')],
        counts
      )
      assert.equal(nativeFeed, '')
    }
    createDesktopUpdater(update.release)
    autoUpdater.emit('update-downloaded')
    assert.equal(nativeInstalls, 0, 'a stale event cannot authorize installation')
    process.stdout.write('Mac retries reuse one listener set without abandoned native proxies\n')
    app.quit()
    return
  }
  if (
    process.argv.includes('--probe-swapped-transport') ||
    process.argv.includes('--probe-native-transport')
  ) {
    let completed = false
    let bodyRequested = false
    autoUpdater.checkForUpdates = () => {
      nativeChecks++
      void (async () => {
        // Swap after staging's source check, restore after its actual transport reads the bytes.
        if (process.argv.includes('--probe-swapped-transport'))
          await writeFile(update.path, Buffer.alloc(bytes.length, 66))
        const read = (url: string): Promise<Buffer> =>
          new Promise((resolve, reject) => {
            const request = get(
              url,
              { headers: url === nativeFeed ? nativeHeaders : {} },
              (response) => {
                const chunks: Buffer[] = []
                response.on('data', (chunk) => chunks.push(chunk))
                response.on('error', reject)
                response.on('end', () => resolve(Buffer.concat(chunks)))
              }
            )
            request.on('error', reject)
          })
        try {
          const descriptor = JSON.parse((await read(nativeFeed)).toString())
          bodyRequested = true
          const status = (
            url: string,
            headers: Record<string, string> = {}
          ): Promise<number | undefined> =>
            new Promise((resolve, reject) => {
              get(url, { headers }, (response) => {
                response.resume()
                response.on('end', () => resolve(response.statusCode))
              }).on('error', reject)
            })
          if (process.argv.includes('--probe-native-transport'))
            assert.equal(await status(descriptor.url, { Range: 'bytes=0-' }), 400)
          const served = await read(descriptor.url)
          if (process.argv.includes('--probe-native-transport'))
            assert.equal(await status(descriptor.url), 404)
          if (process.argv.includes('--probe-native-transport')) assert.deepEqual(served, bytes)
          completed = true
          autoUpdater.emit('update-downloaded')
        } catch {
          autoUpdater.emit('error', new Error('Native transport aborted'))
        } finally {
          await writeFile(update.path, bytes)
        }
      })()
    }
    if (process.argv.includes('--probe-native-transport')) {
      await stageNativeUpdate(update, new AbortController().signal)
      assert.equal(completed, true)
      update.updater.quitAndInstall(false, true)
      assert.equal(nativeInstalls, 1)
      process.stdout.write('Mac verified complete native transport installs once\n')
      app.quit()
      return
    }
    await assert.rejects(stageNativeUpdate(update, new AbortController().signal), /bytes|transport/)
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    await verifyArtifact(update.release, update.path)
    assert.equal(bodyRequested, true, 'the regression must request the actual cache bytes')
    assert.equal(completed, false, 'a swapped archive must never reach native transport EOF')
    assert.equal(nativeInstalls, 0)
    process.stdout.write('Mac swapped/restored cache cannot complete native transport\n')
    app.quit()
    return
  }
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
  const proxyClosed = (): Promise<void> =>
    new Promise((resolve, reject) => {
      get(nativeFeed, (response) => {
        response.resume()
        reject(new Error('Abandoned native proxy is still listening'))
      }).on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') resolve()
        else reject(error)
      })
    })
  const consumeNativeBytes = async (): Promise<void> => {
    const read = (url: string, headers: Record<string, string> = {}): Promise<Buffer> =>
      new Promise((resolve, reject) => {
        get(url, { headers }, (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('error', reject)
          response.on('end', () => resolve(Buffer.concat(chunks)))
        }).on('error', reject)
      })
    const descriptor = JSON.parse((await read(nativeFeed, nativeHeaders)).toString())
    assert.deepEqual(await read(descriptor.url), bytes)
  }
  if (process.argv.includes('--probe-stale-native-event')) {
    const stale = stageNativeUpdate(update, new AbortController().signal)
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    autoUpdater.emit('update-downloaded')
    await assert.rejects(stale, /without verified transport/)
    await assert.rejects(
      stageNativeUpdate(update, new AbortController().signal),
      /Restart required/
    )
    assert.equal(nativeInstalls, 0)
    process.stdout.write('Mac stale native completion cannot authorize a candidate\n')
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
  await consumeNativeBytes()
  autoUpdater.emit('update-downloaded')
  await rejected
  await proxyClosed()
  assert.equal(nativeInstalls, 0)
  const stage = stageNativeUpdate(update, new AbortController().signal)
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  assert.equal(nativeChecks, 2)
  await consumeNativeBytes()
  autoUpdater.emit('update-downloaded')
  await stage
  await proxyClosed()
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
