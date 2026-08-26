# ADR-0012: AI 创作采用统一 `creation` owner

## 状态

已接受 — 2026-08-20

2026-08-26 修订（AI Creation V1 实施规格 [#150](https://github.com/wsgbwps/nevix-ai/issues/150)）：`Organization Publication` 更名为 `Team Publication`；「Supabase/Storage/API 具体职责待 #77 后续 tickets 确定」的悬置已收敛，Supabase 与直传 Storage 等旧假设退场，跨 Module 责任 seam 的权威落点见 [ADR-0016](0016-ai-creation-v1-trusted-seams.md)。

## 背景与决策

AI 创作 V1 的灵感复用、图片与视频生成、创作会话、媒体资产、Team Publication 和 AI Provider Connection 共同组成一条业务闭环。按媒体类型或页面拆分 `video-generation`、`image-editing`、`media` 或 `inspiration` owner 会把一个闭环变成跨 Feature/Module 编排；独立生命周期改由聚合边界表达，不作为拆 Domain 的充分理由。

因此 AI 创作使用唯一 canonical owner `creation`：Desktop 是一个 AI Creation Domain/Feature，Server 是一个复杂 AI Creation Module，可信 OpenAPI seam 也归 `creation`。图片与视频是生成模式，Inspiration Page、Creation Workbench 和 Asset Library 是同一 Feature 的页面；只在实际需要时创建对应 seam，当前不为 AI 创作预建 Electron Main/IPC owner。

## 后果

- Creation Session、Generation Task、Media Asset、Team Publication 和 AI Provider Connection 是 `creation` 内的独立聚合根；Generation Specification 和 Generation Result 是值，AI Provider Job 是 Generation Task 拥有的实体。
- Official Selection 与 Discovery 只在 Inspiration Page 的读取层组合；Discovery、Create Similar 和三个页面都不是独立 Domain。
- 本 ADR 取代 ADR-0001、ADR-0002 和 ADR-0003 中的 `video-generation`、`image-editing` 与 `videogen` AI 业务 owner 示例，不改变它们的自注册、vertical-slice 和复杂度驱动分层决策。
- 生成状态机、发布语义、模板模型与 Storage/Provider/API 的具体职责已由 [#93 收敛出的实施规格 #150](https://github.com/wsgbwps/nevix-ai/issues/150) 确定；实施不得重开已关闭决策，也不得从旧票恢复已被取代的假设。
