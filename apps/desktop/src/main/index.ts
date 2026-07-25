import { app, BrowserWindow, Menu } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { initializeMainI18n } from './i18n'
import { createWindow } from './window/main-window'

Menu.setApplicationMenu(null)

const ipcModules = import.meta.glob('./ipc/*/index.ts', { eager: true })

if (process.env.NEVIX_E2E === '1' && !app.isPackaged && process.env.NEVIX_TEST_USER_DATA_DIR) {
  app.setPath('userData', process.env.NEVIX_TEST_USER_DATA_DIR)
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.nevix.ai')
  await initializeMainI18n()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  for (const mod of Object.values(ipcModules)) {
    ;(mod as { register: () => void }).register()
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
