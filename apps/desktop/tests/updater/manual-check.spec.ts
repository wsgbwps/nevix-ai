import { expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTestApp } from '../helpers/electron-app'

test('@native-smoke system menu manual check visibly defers an unknown instance', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'nevix-manual-update-'))
  try {
    const launched = await launchTestApp({ userDataDir, systemLanguages: ['en-US'] })
    try {
      await launched.electronApp.evaluate(({ Menu, dialog }) => {
        const probe = globalThis as { __updateMessage?: string }
        dialog.showMessageBox = async (
          options: Electron.MessageBoxOptions
        ): Promise<Electron.MessageBoxReturnValue> => {
          probe.__updateMessage = options.message
          return { response: 0, checkboxChecked: false }
        }
        const item = Menu.getApplicationMenu()
          ?.items.flatMap((root) => root.submenu?.items ?? [])
          .find((item) => ['Check for Updates…', '检查更新…'].includes(item.label))
        if (!item) throw new Error('Missing native update menu')
        item.click()
      })
      await expect
        .poll(() =>
          launched.electronApp.evaluate(
            () => (globalThis as { __updateMessage?: string }).__updateMessage
          )
        )
        .toMatch(
          /^(The running Server version could not be verified\. Update deferred\. Check your server connection\.|无法确认当前 Server 的运行版本，更新已暂缓。请检查服务器连接。)$/
        )
      await expect(launched.page.locator('#server-connection-url')).toBeVisible()
    } finally {
      await launched.electronApp.close()
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
})
