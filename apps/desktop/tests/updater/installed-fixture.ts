// Isolated Windows CI fixture: production updater + Window runtime, ephemeral publisher/TLS inputs.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { initializeMainI18n } from '../../src/main/language'
import {
  initializeConnectionRuntime,
  setServerConnectionChangedHandler
} from '../../src/main/connection'
import {
  initializeUpdater,
  checkForUpdatesManually,
  invalidateUpdateInstallation
} from '../../src/main/updater'
import {
  initializeOrdinaryCloseRuntime,
  protectOrdinaryClose,
  decideOrdinaryClose,
  requestApplicationQuit,
  ordinaryCloseRendererUnavailable,
  cancelUpdateInstallation
} from '../../src/main/window/ordinary-close-runtime'
import {
  markOrdinaryCloseRendererReady,
  markOrdinaryCloseRendererUnavailable,
  requestOrdinaryCloseDecision
} from '../../src/main/window/ipc/request-ordinary-close'
import { parseOrdinaryCloseDecision } from '../../src/main/window/ipc/ordinary-close-contract'

interface Scenario {
  readonly id: string
  readonly mode: string
  readonly base: string
}
async function main(): Promise<void> {
  assert.equal(process.platform, 'win32')
  const { root } = JSON.parse(await readFile(join(__dirname, '../fixture.json'), 'utf8'))
  app.setPath('userData', join(root, 'userData'))
  process.env.LOCALAPPDATA = join(root, 'cache-home')
  await mkdir(process.env.LOCALAPPDATA, { recursive: true })
  await app.whenReady()
  const scenario: Scenario = JSON.parse(await readFile(join(root, 'scenario.json'), 'utf8'))
  const write = (result: object): Promise<void> =>
    writeFile(
      join(root, `${scenario.id}.json`),
      JSON.stringify(
        {
          version: app.getVersion(),
          executable: process.execPath,
          ...result
        },
        null,
        2
      )
    )
  if (app.getVersion() === '1.0.1' || scenario.mode === 'initial') {
    await write({ result: 'launched' })
    app.quit()
    return
  }
  let confirmations = 0,
    decisions = 0
  const window = new BrowserWindow({
    show: true,
    webPreferences: { preload: join(__dirname, '../preload.cjs'), sandbox: true }
  })
  initializeOrdinaryCloseRuntime(requestOrdinaryCloseDecision)
  app.on('before-quit', requestApplicationQuit)
  protectOrdinaryClose(window)
  setServerConnectionChangedHandler(invalidateUpdateInstallation)
  await initializeMainI18n()
  await initializeConnectionRuntime()
  ipcMain.handle('window:ordinary-close-ready', (event) => {
    assert.equal(event.sender, window.webContents)
    markOrdinaryCloseRendererReady(window)
  })
  ipcMain.handle('window:decide-ordinary-close', async (event, request) => {
    assert.equal(event.sender, window.webContents)
    decisions++
    try {
      decideOrdinaryClose(window, parseOrdinaryCloseDecision(request))
    } catch {
      cancelUpdateInstallation()
    }
  })
  dialog.showMessageBox = async (...args: unknown[]) => {
    const options = args.at(-1) as Electron.MessageBoxOptions
    if (options.buttons?.length === 1) {
      assert.ok(
        ['server-unavailable', 'replaced-cache'].includes(scenario.mode),
        'only a deliberate verification failure is expected'
      )
      return { response: 0, checkboxChecked: false }
    }
    assert.equal(options.buttons?.length, 2, 'only the explicit install confirmation is expected')
    confirmations++
    return { response: scenario.mode === 'later' ? 1 : 0, checkboxChecked: false }
  }
  ipcMain.handle('fixture:before-decision', async () => {
    if (scenario.mode === 'unavailable') {
      markOrdinaryCloseRendererUnavailable(window)
      ordinaryCloseRendererUnavailable(window)
    }
    if (scenario.mode === 'server-unavailable') await fetch(`${scenario.base}invalidate-version`)
    if (scenario.mode === 'replaced-cache') {
      const replace = async (dir: string): Promise<void> => {
        for (const item of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, item.name)
          if (item.isDirectory()) await replace(path)
          else if (item.name.endsWith('.exe')) await writeFile(path, 'replaced cached installer')
        }
      }
      await replace(process.env.LOCALAPPDATA!)
    }
  })
  await window.loadFile(join(__dirname, '../renderer.html'), { query: { mode: scenario.mode } })
  await window.webContents.executeJavaScript('window.fixtureReady')
  await initializeUpdater()
  if (scenario.mode !== 'ordinary') await checkForUpdatesManually()
  await write({ result: 'completed', confirmations, decisions })
  if (scenario.mode !== 'approved') {
    markOrdinaryCloseRendererUnavailable(window)
    ordinaryCloseRendererUnavailable(window)
    app.quit()
  }
}
void main().catch((error) => {
  console.error(error)
  app.exit(1)
})
