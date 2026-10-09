import { app, BrowserWindow, dialog, Notification, type MenuItemConstructorOptions } from 'electron'
import { readCurrentServerVersion, currentServerConnectionIdentity } from '../connection'
import { getInterfaceLanguage } from '../language'
import { checkForRelease, assertCompatibleServer, type UpdateCheckResult } from './release-trust'
import { compareVersions } from './release-trust'
import { readOfficialRelease, RELEASE_PUBLIC_KEY_PEM } from './official-source'
import { updateTranslations } from './resources'
import {
  cancelUpdateInstallation,
  requestUpdateInstallation
} from '../window/ordinary-close-runtime'
import { downloadTrustedUpdate, type DownloadedUpdate } from './signed-provider'
import { verifyArtifact, verifyArtifactSync } from './release-artifact'
let operation: Promise<void> = Promise.resolve()
let generation = 0
let downloaded: (DownloadedUpdate & { readonly connectionIdentity: string }) | undefined
const accepted = new Map<string, string>()

export function invalidateUpdateInstallation(): void {
  generation++
  downloaded = undefined
  cancelUpdateInstallation()
}
export function initializeUpdater(): Promise<void> {
  app.on('before-quit', invalidateUpdateInstallation)
  const startup = enqueueCheck(false)
  const interval = setInterval(
    () => {
      void enqueueCheck(false)
    },
    12 * 60 * 60 * 1000
  )
  interval.unref()
  return startup
}
function enqueueCheck(manual: boolean): Promise<void> {
  const next = operation.then(() => check(manual))
  operation = next.catch(() => undefined)
  return operation
}
function text(
  key: keyof typeof updateTranslations.en,
  values: Record<string, string> = {}
): string {
  let value: string = updateTranslations[getInterfaceLanguage()][key]
  for (const [name, replacement] of Object.entries(values))
    value = value.replace(`{{${name}}}`, replacement)
  return value
}
export function updateMenuItem(): MenuItemConstructorOptions {
  return {
    label: text('menu'),
    click: () => {
      void checkForUpdatesManually()
    }
  }
}
export function checkForUpdatesManually(): Promise<void> {
  return enqueueCheck(true)
}
async function check(manual: boolean): Promise<void> {
  const token = generation
  const connectionIdentity = currentServerConnectionIdentity()
  try {
    const result = await checkForRelease({
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      publicKeyPem: RELEASE_PUBLIC_KEY_PEM,
      readRelease: () => readOfficialRelease(process.platform, process.arch),
      readServer: readCurrentServerVersion
    })
    if (token !== generation) return
    if (result.outcome !== 'available' || process.platform !== 'win32') {
      if (manual) await showResult(result)
      return
    }
    const descriptor = JSON.stringify(result.release)
    const previous = accepted.get(result.release.version)
    if (previous && previous !== descriptor) throw new Error('Same-version artifact replacement')
    accepted.set(result.release.version, descriptor)
    if (
      !downloaded ||
      JSON.stringify(downloaded.release) !== descriptor ||
      downloaded.connectionIdentity !== connectionIdentity
    ) {
      const update = await downloadTrustedUpdate(result.release)
      assertCompatibleServer(
        update.release,
        app.getVersion(),
        connectionIdentity,
        await readCurrentServerVersion()
      )
      if (token !== generation) return
      downloaded = Object.freeze({ ...update, connectionIdentity })
    }
    const update = downloaded
    if (manual) await offerInstallation(update, token)
    else if (Notification.isSupported()) {
      const notification = new Notification({
        title: text('title'),
        body: text('ready', { version: update.release.version })
      })
      notification.on('click', () => {
        void checkForUpdatesManually()
      })
      notification.show()
    }
  } catch {
    if (manual && token === generation) await showResult({ outcome: 'failed' })
  }
}
async function offerInstallation(
  update: DownloadedUpdate & { readonly connectionIdentity: string },
  token: number
): Promise<void> {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!window || window.isDestroyed()) return
  await verifyArtifact(update.release, update.path)
  assertCompatibleServer(
    update.release,
    app.getVersion(),
    update.connectionIdentity,
    await readCurrentServerVersion()
  )
  const choice = await dialog.showMessageBox(window, {
    type: 'info',
    title: text('title'),
    message: text('ready', { version: update.release.version }),
    detail: text('installDetail'),
    buttons: [text('install'), text('later')],
    defaultId: 1,
    cancelId: 1
  })
  if (choice.response !== 0 || token !== generation || window.isDestroyed()) {
    cancelUpdateInstallation()
    return
  }
  let validationFailed = false
  await requestUpdateInstallation(
    window,
    async () => {
      try {
        assertCompatibleServer(
          update.release,
          app.getVersion(),
          update.connectionIdentity,
          await readCurrentServerVersion()
        )
        if (token !== generation) throw new Error('Update installation cancelled')
      } catch (error) {
        validationFailed = true
        throw error
      }
    },
    () => {
      if (token !== generation || currentServerConnectionIdentity() !== update.connectionIdentity)
        throw new Error('Update instance changed')
      try {
        verifyArtifactSync(update.release, update.path)
        update.updater.quitAndInstall(false, true)
      } catch (error) {
        validationFailed = true
        throw error
      }
    }
  )
  if (validationFailed && token === generation) await showResult({ outcome: 'failed' })
}
async function showResult(result: UpdateCheckResult): Promise<void> {
  const message =
    result.outcome === 'current'
      ? text('current')
      : result.outcome === 'available'
        ? text('available', { version: result.release.version })
        : result.outcome === 'server-upgrade-required'
          ? text('serverUpgrade', { minimum: result.minimum })
          : result.outcome === 'desktop-upgrade-required'
            ? text('desktopUpgrade', { minimum: result.minimum })
            : result.outcome === 'server-unavailable'
              ? text('unavailable')
              : result.outcome === 'trust-unconfigured'
                ? text('trust')
                : text('failed')
  await dialog.showMessageBox({
    type: result.outcome === 'failed' ? 'warning' : 'info',
    title: text('title'),
    message,
    buttons: [text('ok')]
  })
}
export async function checkInstalledDesktopCompatibility(): Promise<void> {
  try {
    const server = await readCurrentServerVersion()
    compareVersions(server.version, '0.0.0')
    if (compareVersions(app.getVersion(), server.min_desktop_version) < 0)
      await showResult({ outcome: 'desktop-upgrade-required', minimum: server.min_desktop_version })
  } catch {
    /* Startup connection failures remain on the existing connection screen. */
  }
}
