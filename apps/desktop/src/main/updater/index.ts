import { app, dialog, type MenuItemConstructorOptions } from 'electron'
import { readCurrentServerVersion } from '../connection'
import { getInterfaceLanguage } from '../language'
import { checkForRelease, type UpdateCheckResult } from './release-trust'
import { compareVersions } from './release-trust'
import { readOfficialRelease, RELEASE_PUBLIC_KEY_PEM } from './official-source'
import { updateTranslations } from './resources'
let checking = false
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
export async function checkForUpdatesManually(): Promise<void> {
  if (checking) return
  checking = true
  try {
    const result = await checkForRelease({
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      publicKeyPem: RELEASE_PUBLIC_KEY_PEM,
      readRelease: () => readOfficialRelease(process.platform, process.arch),
      readServer: readCurrentServerVersion
    })
    await showResult(result)
  } finally {
    checking = false
  }
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
