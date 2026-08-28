import { Menu, type BrowserWindow } from 'electron'
import { getNativeEditMenuLabels } from '../language'
import { applicationMenuTemplate, nativeEditItems } from './application-menu'

// 键等价键必须挂在可见菜单项上（原因见 application-menu.ts 的模板注释）；
// 语言切换时由 refreshApplicationMenu 重建以更新标签。
function installNativeEditAccelerators(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(applicationMenuTemplate(process.platform, getNativeEditMenuLabels()))
  )
}

export function refreshApplicationMenu(): void {
  installNativeEditAccelerators()
}

export function enableNativeEditing(window: BrowserWindow): void {
  installNativeEditAccelerators()

  window.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return

    const menu = Menu.buildFromTemplate(
      nativeEditItems(params.editFlags, getNativeEditMenuLabels())
    )
    menu.popup({
      window,
      ...(params.frame ? { frame: params.frame } : {})
    })
  })
}
