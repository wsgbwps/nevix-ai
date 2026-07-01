# Desktop

Electron 桌面客户端，采用 Feature-Sliced Design 组织渲染进程，IPC 层按 domain 拆分。

## Language

**Feature**:
一个完整的垂直功能切片，包含 UI 组件、hooks、API 层和可选的状态管理。对应 `renderer/src/features/<name>/` 目录。
_Avoid_: module, component, page

**Channel**:
主进程与渲染进程之间的 IPC 通信通道，以 `<domain>:<action>` 格式命名。类型在 `IpcChannelMap` 中声明。
_Avoid_: event（与 push event 混淆）, message, route

**Handler**:
主进程中处理单个 IPC Channel 请求的函数，每个 handler 独立一个文件。
_Avoid_: controller, listener

**Domain**:
按业务功能划分的代码组织单元（如 video-generation、image-editing），贯穿 shared/ipc、main/ipc 和 renderer/features 三层。
_Avoid_: module（与 Go 侧混淆）, service
