# 主进程重构与 Typed Preload 桥接

Status: done

## Parent

[Architecture Scaffolding PRD](../PRD.md)

## What to build

重构 Electron 主进程，使 `main/index.ts` 成为纯组装器（app 生命周期 + IPC handler 自动注册），不包含业务逻辑。

将窗口创建逻辑提取到 `main/window/main-window.ts`，导出 `createWindow()` 函数。

在 `main/index.ts` 中通过 `import.meta.glob('./ipc/*/index.ts', { eager: true })` 自动发现并注册所有 domain 的 IPC handler。创建 `main/ipc/` 目录（放 `.gitkeep`），使 glob 有目标。当前匹配零个文件不报错。

将 `app.setAppUserModelId` 从 `'com.electron'` 修正为 `'com.nevix.ai'`。

改造 preload 层：实现 `typedInvoke<K extends keyof IpcChannelMap>` 和 `typedOn<K extends keyof IpcEventMap>` 两个泛型函数，通过 `contextBridge.exposeInMainWorld` 暴露给 renderer。同步更新 `preload/index.d.ts` 声明 `window.api` 的类型。preload 不包含 per-domain 代码，加新 domain 永远不需要编辑 preload。

参考 ADR-0001 中关于运行时自注册和 Preload 通用化的决策。

## Acceptance criteria

- [x] `main/window/main-window.ts` 存在，导出 `createWindow()` 函数
- [x] `main/index.ts` 仅包含 app 生命周期管理和 IPC 自注册逻辑，import 并调用 `createWindow()`
- [x] `main/index.ts` 使用 `import.meta.glob('./ipc/*/index.ts', { eager: true })` 自动发现 handler
- [x] `main/ipc/` 目录存在（含 `.gitkeep`）
- [x] `electronApp.setAppUserModelId('com.nevix.ai')` 已设置
- [x] `preload/index.ts` 暴露 `typedInvoke` 和 `typedOn` 泛型函数
- [x] `preload/index.d.ts` 声明 `window.api` 包含 `invoke` 和 `on` 方法的类型
- [x] 移除模板遗留代码（`ipcMain.on('ping', ...)` 等）
- [x] `pnpm typecheck` 通过
- [x] `pnpm build` 通过

## Blocked by

- [01-ipc-type-system](./01-ipc-type-system.md)
