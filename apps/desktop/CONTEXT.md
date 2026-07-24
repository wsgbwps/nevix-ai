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

**Localized Surface**:
Desktop 拥有的全部用户可见文案，包括渲染界面、窗口、原生桌面交互、安装流程和系统权限说明；不包括品牌名、用户内容、服务端日志或第三方原文。
_Avoid_: UI text（范围过窄）, all text（范围过宽）

**Language Mode**:
设备本地保存的语言选择，可取跟随系统（默认）、简体中文或英文，不属于账号数据。
_Avoid_: language setting（未区分选择与结果）, locale

**Interface Language**:
Localized Surface 文案实际采用的语言，不决定时区、日期与数字格式、货币、计量单位或业务数据；跟随系统时在应用启动阶段解析，中文系统采用简体中文，英文系统采用英文，其他系统语言回退到简体中文。
Language Mode 改变后，当前运行中的 Localized Surface 无需重启即可采用新的 Interface Language；正式支持语言的资源意外缺失时回退到简体中文。
_Avoid_: Language Mode, app language

**Supported Language**:
翻译资源已覆盖全部 Localized Surface、由发布检查持续保证完整性、并向正式版用户开放选择的 Interface Language；当前为简体中文和英文。
_Avoid_: available language（未表达完整性承诺）, translation file
