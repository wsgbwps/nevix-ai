# ADR-0018: 任务结果复用为参考素材走渲染层重上传

## 状态

已接受 — 2026-09-04。

2026-09-09 修订（[#225](https://github.com/wsgbwps/nevix-ai/issues/225)，[#220](https://github.com/wsgbwps/nevix-ai/issues/220) 前置）：生成结果复用改为 creator-authorized Server 转换命令；原 Renderer 重建 programmatic `File` 并重传的决定退场。

## 背景

Creation Workbench 支持把任务 slot 结果拖入 reference deck 复用为参考素材。任务结果（`SlotResultView`）只有 checksum、MIME 与尺寸元数据，没有 material 身份；而素材是会话资产，必须由独立的 Reference Material identity 与权利声明形成。

原决定让 Renderer 取回结果字节、重建 programmatic `File` 并走素材上传通路。#220 将用户选择的本地文件上传收敛为唯一的 Electron Main 原生直传 seam：Preload 只能用 `webUtils.getPathForFile(file)` 解析真实磁盘路径，完整文件不经 IPC。programmatic `File` 没有真实路径；继续原方案只能破坏结果复用，或保留第二条 multipart/whole-file IPC 通路并违反 ADR-0014/0016。

## 决策

- 采用 **creator-authorized Server 转换命令**：Renderer 只提交 owned Generation Task、slot 与目标 Creation Session identity；Go 同时验证 task result 与 session 的 creator ownership，Admin 没有旁路，任一不存在或不属于当前 Creator 都返回相同的 `not_found`。
- Go 从已持久化 Generation Result 流式读取完整内容，复用 Reference Material 的权威内容嗅探、媒体结构 probe、实际 kind 限额与 SHA-256 形成路径；Storage I/O 全在事务外。全部验证成功后，verified Creation 写事务才创建一个新的 immutable Reference Material。
- 新素材保持独立 identity、对象与权利事实；不因 checksum 相同而去重，也不把 Generation Result 直接改造成素材。结果文件名只作为非权威展示事实。
- 命令不向 Renderer 返回结果字节、对象 key、签名 URL 或请求头；Desktop 不再为结果复用构造 `File`。用户选择的本地文件仍只走 ADR-0014/0016 的 Main 原生预签名 PUT。

## Considered Options

- **保留 Renderer 重传并让 programmatic `File` 绕过真实路径要求**：必须把完整结果字节重新放进 IPC 或保留旧 multipart route，形成第二条永久素材上传边界；否决。
- **先下载结果到 Main 临时文件，再执行预签名 PUT**：避免 whole-file IPC，但新增临时文件权限、清理与崩溃恢复生命周期，只为搬运 Server 已有字节；否决。
- **删除结果复用**：避免新 seam，但会让已交付的拖拽复用能力回归；否决。

## 后果

- `contracts/creation.yaml` 增加窄的 result-to-material command；它属于既有 Creation owner，不产生新 Domain、Module 或通用 copy API。
- #220 删除旧 multipart material-create route 时同步迁移 Desktop 的结果拖拽调用，不保留兼容通路。
- 多结果批量复用、checksum 去重或结果原地改造仍不属于 V1；出现真实需求时另行决策。
