# ADR-0018: 任务结果复用为参考素材走渲染层重上传

## 状态

已接受 — 2026-09-04。

## 背景

Creation Workbench 支持把任务 slot 结果拖入 reference deck 复用为参考素材。任务结果（`SlotResultView`）只有 checksum、MIME 与尺寸元数据，没有 material 身份；而素材是会话资产，只能经 `POST /creation/sessions/{id}/materials` 产生。复用通路有两条：渲染层取回结果字节重建 `File` 走既有上传通路，或新增服务端「结果转素材」端点。

## 决策

- 采用**渲染层重上传**：drop 时按 `taskId + slotIndex` 经可信数据面取回结果字节（复用 `loadResultBlobUrl` 的取回路径），以与结果下载按钮相同的文件名约定构造 `File`，经既有素材上传通路入册（追加或原位替换）。字节路径为 服务端 → 渲染层 → 服务端，产生一份独立新素材，与服务端是否已存同 checksum 字节无关。
- 不新增服务端端点，`contracts/` 与 Go 侧不变；该能力完全收敛在 Desktop Creation Feature 内。

## Considered Options

- **服务端「结果转素材」端点**（如 `POST /creation/tasks/{taskId}/slots/{i}/material`）：字节不绕圈、无重复存储，但要修改公共契约（AGENTS.md 高险项）并为 V1 最低频的场景引入新 seam；单租户 on-prem 部署下绕一圈本地字节流的成本可忽略。否决——留作后置条件。

## 后果

- 后置条件：出现多结果批量复用、素材存储去重或结果资产直接入库的真实诉求时，重开服务端端点任务并以新 ADR 取代本文。
- 未来读者若疑惑「为什么把服务端已有的字节再传一遍」，答案在此，而非在代码里补注释。
