import { BrowserWindow } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'node:url'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import { getMainWindowTitle } from '../language'
import { ordinaryCloseRendererUnavailable, protectOrdinaryClose } from './ordinary-close-runtime'
import {
  loadWindowState,
  trackWindowState,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH
} from './window-state'
import { enableNativeEditing } from './native-editing'

/** The only document this application loads, and therefore the only trusted IPC sender URL. */
export function rendererEntryUrl(): string {
  const developmentUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && developmentUrl) return new URL(developmentUrl).href

  return pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

export function createWindow(
  markOrdinaryCloseRendererUnavailable: (window: BrowserWindow) => void
): void {
  const state = loadWindowState()
  const mainWindow = new BrowserWindow({
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    width: state.width,
    height: state.height,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
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

  protectOrdinaryClose(mainWindow)
  enableNativeEditing(mainWindow)
  trackWindowState(mainWindow)

  const handleOrdinaryCloseRendererUnavailable = (): void => {
    markOrdinaryCloseRendererUnavailable(mainWindow)
    ordinaryCloseRendererUnavailable(mainWindow)
  }
  mainWindow.webContents.on('did-start-loading', handleOrdinaryCloseRendererUnavailable)
  mainWindow.webContents.on('render-process-gone', handleOrdinaryCloseRendererUnavailable)

  mainWindow.webContents.session.setPermissionCheckHandler(() => false)
  mainWindow.webContents.session.setPermissionRequestHandler((_, __, callback) => {
    callback(false)
  })
  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    if (state.isMaximized) mainWindow.maximize()
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // A same-URL navigation is the document reload the connection Domain uses
    // to apply runtime state (the connect-src CSP); every other navigation
    // would leave this window's single trusted document.
    if (url === mainWindow.webContents.getURL()) return
    event.preventDefault()
  })

  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
  })

  const notifyRendererDeactivated = (): void => {
    if (!mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('window:deactivated')
    }
  }
  mainWindow.on('blur', notifyRendererDeactivated)
  mainWindow.on('minimize', notifyRendererDeactivated)

  mainWindow.loadURL(rendererEntryUrl())
}
