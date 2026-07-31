# Language Mode 由主进程持有

2026-07-30：[ADR-0003](0003-main-domain-first-ipc-adapters.md) 将 Language Mode 与 Interface Language 合并归入 Language Domain；下文的 `settings` IPC 名称保留为原始记录，主进程 ownership 决定继续有效。

Electron 主进程是 Language Mode 的唯一权威来源，将设备本地选择持久化到应用的 `userData` 目录，并通过 `settings` IPC 向渲染进程提供。相比使用渲染进程 `localStorage`，这一边界让 React 界面、窗口和原生桌面交互共享同一设置，同时避免把设备偏好扩大为账号或服务端数据。
