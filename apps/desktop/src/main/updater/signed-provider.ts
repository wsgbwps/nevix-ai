import {
  AppUpdater,
  NsisUpdater,
  MacUpdater,
  Provider,
  type UpdateInfo,
  type ResolvedUpdateFileInfo
} from 'electron-updater'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider'
import { assertUpdaterDescription, verifyArtifact } from './release-artifact'
import { downloadReleaseArtifact } from './download'
import type { Release } from './release-trust'
import { autoUpdater as nativeUpdater } from 'electron'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

let nativeStagingFailed = false
let nativeStagingActive = false
let macUpdater: TrustedMacUpdater | undefined
let boundMacRelease: Release | undefined
export class NativeUpdateStagingFailure extends Error {}

// Keep the library's checked metadata/cache API, but never expose its unverified cache proxy.
class TrustedMacUpdater extends MacUpdater {
  protected async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    const release = boundMacRelease!
    const files = options.updateInfoAndProvider.provider.resolveFiles(
      options.updateInfoAndProvider.info
    )
    assertUpdaterDescription(release, options.updateInfoAndProvider.info, files)
    if (!new URL(release.url).pathname.endsWith('.zip')) throw new Error('Mac update requires ZIP')
    return this.executeDownload({
      fileExtension: 'zip',
      fileInfo: files[0],
      downloadUpdateOptions: options,
      task: (destination) =>
        options.cancellationToken.createPromise((resolve, reject, onCancel) => {
          const controller = new AbortController()
          onCancel(() => controller.abort())
          void downloadReleaseArtifact(
            release,
            destination,
            AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60 * 1000)])
          ).then(resolve, reject)
        }),
      done: async (event) => {
        this.dispatchUpdateDownloaded(event)
      }
    })
  }
}

// Squirrel staging happens after Window allow, before granting the one close bypass.
export async function stageNativeUpdate(
  update: DownloadedUpdate,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  if (!(update.updater instanceof MacUpdater)) return
  if (nativeStagingFailed)
    throw new NativeUpdateStagingFailure('Restart required after native update staging failure')
  if (
    nativeStagingActive ||
    update.updater !== macUpdater ||
    JSON.stringify(update.release) !== JSON.stringify(boundMacRelease)
  )
    throw new Error('Mac update candidate changed or staging is active')
  nativeStagingActive = true
  try {
    await verifyArtifact(update.release, update.path)
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const token = randomBytes(32).toString('hex')
      const feedPath = `/${token}.json`,
        zipPath = `/${token}.zip`
      let served = false
      let transportVerified = false
      let settled = false
      const server = createServer((request, response) => {
        if (request.method !== 'GET' || request.headers.range) {
          response.writeHead(400).end()
          return
        }
        const address = server.address()
        if (!address || typeof address === 'string') {
          response.writeHead(503).end()
          return
        }
        if (request.url === feedPath) {
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify({ url: `http://127.0.0.1:${address.port}${zipPath}` }))
          return
        }
        if (request.url !== zipPath || served) {
          response.writeHead(404).end()
          return
        }
        served = true
        const hash = createHash('sha512')
        let size = 0,
          last: Buffer | undefined
        const verifier = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length
            if (size > update.release.size) {
              callback(new Error('Wrong artifact bytes'))
              return
            }
            hash.update(chunk)
            if (last) this.push(last)
            last = chunk
            callback()
          },
          flush(callback) {
            if (size !== update.release.size || hash.digest('base64') !== update.release.sha512) {
              callback(new Error('Wrong artifact bytes'))
              return
            }
            // Squirrel cannot receive a complete response until the exact served bytes pass.
            if (last) this.push(last)
            callback()
          }
        })
        response.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': update.release.size
        })
        void pipeline(createReadStream(update.path), verifier, response).then(() => {
          transportVerified = true
        }, failed)
      })
      const cleanup = (): void => {
        clearTimeout(timeout)
        server.closeAllConnections()
        server.close()
        nativeUpdater.removeListener('update-downloaded', ready)
        nativeUpdater.removeListener('error', failed)
      }
      const ready = (): void => {
        if (settled) return
        if (!transportVerified) {
          failed(new Error('Native update completed without verified transport'))
          return
        }
        settled = true
        cleanup()
        if (signal.aborted) reject(signal.reason)
        else resolve()
      }
      const failed = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        // Native checks cannot be cancelled; do not consume a late result in another attempt.
        nativeStagingFailed = true
        reject(new NativeUpdateStagingFailure(error.message))
      }
      const timeout = setTimeout(() => failed(new Error('Native update staging timed out')), 45000)
      nativeUpdater.once('update-downloaded', ready)
      nativeUpdater.once('error', failed)
      server.once('error', failed)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          failed(new Error('Invalid native transport'))
          return
        }
        try {
          nativeUpdater.setFeedURL({ url: `http://127.0.0.1:${address.port}${feedPath}` })
          nativeUpdater.checkForUpdates()
        } catch (error) {
          failed(error as Error)
        }
      })
    })
  } finally {
    nativeStagingActive = false
  }
}

export function configureSignedUpdater(updater: AppUpdater, release: Release): void {
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.disableDifferentialDownload = true
  updater.disableWebInstaller = true
  updater.allowPrerelease = false
  updater.allowDowngrade = false
  updater.logger = null
  const file = Object.freeze({ url: release.url, size: release.size, sha512: release.sha512 })
  const info: UpdateInfo = Object.freeze({
    version: release.version,
    files: [file],
    releaseDate: '',
    path: release.url,
    sha512: release.sha512
  })
  Object.freeze(info.files)
  class SignedProvider extends Provider<UpdateInfo> {
    constructor(_options: unknown, _updater: AppUpdater, runtime: ProviderRuntimeOptions) {
      super({ ...runtime, isUseMultipleRangeRequest: false })
      // 6.8.9 shares this executor with its downloader; replace only full artifact transport.
      runtime.executor.download = (url, destination, options) => {
        if (url.href !== new URL(release.url).href)
          return Promise.reject(new Error('Wrong artifact URL'))
        return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
          const controller = new AbortController()
          onCancel(() => controller.abort())
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60 * 1000)])
          void downloadReleaseArtifact(release, destination, signal).then(
            () => resolve(destination),
            reject
          )
        })
      }
    }
    async getLatestVersion(): Promise<UpdateInfo> {
      return info
    }
    resolveFiles(value: UpdateInfo): ResolvedUpdateFileInfo[] {
      const files = [{ url: new URL(release.url), info: file }]
      assertUpdaterDescription(release, value, files)
      return files
    }
  }
  updater.setFeedURL({ provider: 'custom', updateProvider: SignedProvider })
}
export function createDesktopUpdater(release: Release): AppUpdater {
  if (release.platform === 'darwin' && nativeStagingFailed)
    throw new NativeUpdateStagingFailure('Restart required after native update staging failure')
  if (release.platform === 'darwin' && nativeStagingActive)
    throw new Error('Native update staging is active')
  const updater =
    release.platform === 'win32' && release.arch === 'x64'
      ? new NsisUpdater()
      : release.platform === 'darwin' && release.arch === 'arm64'
        ? (macUpdater ??= new TrustedMacUpdater())
        : undefined
  if (!updater) throw new Error('Unsupported Desktop update platform')
  if (updater === macUpdater) boundMacRelease = Object.freeze({ ...release })
  configureSignedUpdater(updater, release)
  return updater
}
export interface DownloadedUpdate {
  readonly release: Release
  readonly path: string
  readonly updater: AppUpdater
}
export async function downloadTrustedUpdate(
  release: Release,
  createUpdater: (release: Release) => AppUpdater = createDesktopUpdater
): Promise<DownloadedUpdate> {
  const bound = Object.freeze({ ...release })
  const updater = createUpdater(bound)
  if (updater.autoDownload || updater.autoInstallOnAppQuit || !updater.disableDifferentialDownload)
    throw new Error('Unsafe updater policy')
  const checked = await updater.checkForUpdates()
  if (!checked?.isUpdateAvailable || checked.downloadPromise)
    throw new Error('Update is not eligible')
  assertUpdaterDescription(
    bound,
    checked.updateInfo,
    checked.updateInfo.files.map((info) => ({ url: new URL(info.url), info }))
  )
  const paths = await updater.downloadUpdate()
  if (paths.length !== 1) throw new Error('Unexpected update artifacts')
  await verifyArtifact(bound, paths[0])
  return Object.freeze({ release: bound, path: paths[0], updater })
}
