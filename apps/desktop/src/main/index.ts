import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createWindow } from './window/main-window'

const ipcModules = import.meta.glob('./ipc/*/index.ts', { eager: true })

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.nevix.ai')

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
