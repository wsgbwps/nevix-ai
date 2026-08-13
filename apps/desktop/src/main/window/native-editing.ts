import { Menu, type BrowserWindow, type EditFlags, type MenuItemConstructorOptions } from 'electron'

function nativeEditItems(editFlags?: EditFlags): MenuItemConstructorOptions[] {
  return [
    { role: 'undo', ...(editFlags ? { enabled: editFlags.canUndo } : {}) },
    { type: 'separator' },
    { role: 'cut', ...(editFlags ? { enabled: editFlags.canCut } : {}) },
    { role: 'copy', ...(editFlags ? { enabled: editFlags.canCopy } : {}) },
    { role: 'paste', ...(editFlags ? { enabled: editFlags.canPaste } : {}) },
    { role: 'delete', ...(editFlags ? { enabled: editFlags.canDelete } : {}) },
    { type: 'separator' },
    { role: 'selectAll', ...(editFlags ? { enabled: editFlags.canSelectAll } : {}) }
  ]
}

function installNativeEditAccelerators(): void {
  const hiddenEditItems = nativeEditItems()
    .filter((item) => item.type !== 'separator')
    .map((item) => ({ ...item, visible: false }))

  Menu.setApplicationMenu(Menu.buildFromTemplate(hiddenEditItems))
}

export function enableNativeEditing(window: BrowserWindow): void {
  installNativeEditAccelerators()

  window.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return

    const menu = Menu.buildFromTemplate(nativeEditItems(params.editFlags))
    menu.popup({
      window,
      ...(params.frame ? { frame: params.frame } : {})
    })
  })
}
