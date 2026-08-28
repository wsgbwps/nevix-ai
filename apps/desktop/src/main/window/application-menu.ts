import type { EditFlags, MenuItemConstructorOptions } from 'electron'
import type { NativeEditMenuLabels } from '../language'

// 编辑命令项的单一来源：应用菜单与右键菜单共用同一份定义。editFlags 由调用方
// 决定——应用菜单路径不传（加速器常驻可用），右键菜单路径传 webContents 的
// 实际能力。
export function nativeEditItems(
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

// macOS 只为应用菜单里**可见**的 role 项注册键等价键（Cmd+C/V/X/Z/A）：
// AppKit 的键等价匹配会跳过 isHidden 项，此前的"隐藏菜单项"方案让复制/粘贴
// 在全应用失效（直到长串凭据需要粘贴才暴露）。macOS 的第一个顶级菜单固定是
// 应用菜单，因此显式补上 appMenu role；Windows/Linux 的编辑快捷键由 Chromium
// 原生处理，窗口又是 autoHideMenuBar，可见 Edit 菜单默认不占界面。
export function applicationMenuTemplate(
  platform: NodeJS.Platform,
  labels: NativeEditMenuLabels
): MenuItemConstructorOptions[] {
  return [
    ...(platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: labels.editMenu,
      submenu: nativeEditItems(undefined, labels)
    }
  ]
}
