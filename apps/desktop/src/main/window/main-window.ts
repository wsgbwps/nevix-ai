import { BrowserWindow } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'node:url'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import { getMainWindowTitle } from '../language'

/** The only document this application loads, and therefore the only trusted IPC sender URL. */
export function rendererEntryUrl(): string {
  const developmentUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && developmentUrl) return new URL(developmentUrl).href

  return pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

export function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    title: getMainWindowTitle(),
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  mainWindow.webContents.session.setPermissionCheckHandler(() => false)
  mainWindow.webContents.session.setPermissionRequestHandler((_, __, callback) => {
    callback(false)
  })
  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
  })

  mainWindow.loadURL(rendererEntryUrl())
}
