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

let nativeStagingFailed = false
export class NativeUpdateStagingFailure extends Error {}

// Squirrel staging happens after Window allow, before granting the one close bypass.
export async function stageNativeUpdate(
  update: DownloadedUpdate,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  if (!(update.updater instanceof MacUpdater)) return
  if (nativeStagingFailed)
    throw new NativeUpdateStagingFailure('Restart required after native update staging failure')
  await verifyArtifact(update.release, update.path)
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout)
      nativeUpdater.removeListener('update-downloaded', ready)
      nativeUpdater.removeListener('error', failed)
    }
    const ready = (): void => {
      cleanup()
      if (signal.aborted) reject(signal.reason)
      else resolve()
    }
    const failed = (error: Error): void => {
      cleanup()
      // Native checks cannot be cancelled; do not consume a late result in another attempt.
      nativeStagingFailed = true
      reject(new NativeUpdateStagingFailure(error.message))
    }
    const timeout = setTimeout(() => failed(new Error('Native update staging timed out')), 45000)
    nativeUpdater.once('update-downloaded', ready)
    nativeUpdater.once('error', failed)
    try {
      nativeUpdater.checkForUpdates()
    } catch (error) {
      failed(error as Error)
    }
  })
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
  const updater =
    release.platform === 'win32' && release.arch === 'x64'
      ? new NsisUpdater()
      : release.platform === 'darwin' && release.arch === 'arm64'
        ? new MacUpdater()
        : undefined
  if (!updater) throw new Error('Unsupported Desktop update platform')
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
