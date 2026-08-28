import { Menu, type BrowserWindow, type EditFlags, type MenuItemConstructorOptions } from 'electron'
import { getNativeEditMenuLabels, type NativeEditMenuLabels } from '../language'

function nativeEditItems(
  editFlags?: EditFlags,
  labels?: NativeEditMenuLabels
): MenuItemConstructorOptions[] {
  return [
    { role: 'undo', label: labels?.undo, enabled: editFlags?.canUndo ?? true },
    { type: 'separator' },
    { role: 'cut', label: labels?.cut, enabled: editFlags?.canCut ?? true },
    { role: 'copy', label: labels?.copy, enabled: editFlags?.canCopy ?? true },
    { role: 'paste', label: labels?.paste, enabled: editFlags?.canPaste ?? true },
    { role: 'delete', label: labels?.delete, enabled: editFlags?.canDelete ?? true },
    { type: 'separator' },
    { role: 'selectAll', label: labels?.selectAll, enabled: editFlags?.canSelectAll ?? true }
  ]
}

function installNativeEditAccelerators(): void {
  // macOS matches real keystrokes against NSMenu key equivalents and skips
  // invisible items, so the edit roles must sit in a visible Edit submenu for
  // the accelerators to reach the focused editable. The hidden root-level items
  // below only work on platforms where Chromium dispatches menu accelerators
  // internally, never through NSMenu.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: getNativeEditMenuLabels().menu, submenu: nativeEditItems() }
      ])
    )
    return
  }

  const hiddenEditItems = nativeEditItems()
    .filter((item) => item.type !== 'separator')
    .map((item) => ({ ...item, visible: false }))

  Menu.setApplicationMenu(Menu.buildFromTemplate(hiddenEditItems))
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
