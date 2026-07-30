---
kind: external_dependency
name: Electron 桌面应用框架
slug: electron
category: external_dependency
category_hints:
    - framework_behavior
scope:
    - '**'
---

### Electron
- 角色：跨平台桌面应用运行时，包含主进程、预加载层和渲染进程三层架构
- 集成点：electron-vite 作为开发工具链，electron-builder 负责打包分发
- 架构模式：主进程负责系统级操作（窗口管理、IPC handler 注册），预加载层暴露安全的 typedInvoke/typedOn API，渲染进程运行 React 应用
- 安全边界：preload 层通过 contextBridge 暴露最小权限接口，业务逻辑隔离在各自进程中
- 打包配置：支持 Windows (NSIS)、macOS (DMG)、Linux (AppImage/snap/deb) 多平台发布