# PR 交付说明草稿（#177）— 待用户验证后再推送开 PR

## Primary Domain 与最窄 owner

AI Creation；owner = creation（Server `server/internal/creation`、Desktop `features/creation`、contract `contracts/creation.yaml`）。一个 squash commit，可独立 revert。

## 高风险计划

[.scratch/177-creation-workbench-draft/high-risk-plan.md](high-risk-plan.md)（持久数据 + 授权，编码前完成）。

## 变更概要

- Contract（先行）：`PUT /creation/sessions/{sessionID}/draft`（`SessionDraftInput`/`SessionDraft`/`DraftReferenceInput`，稳定错误沿用既有 vocabulary）；`getSession` 升级为 `CreationSessionDetail`（内嵌 nullable draft）。
- Server：migration `0007_creation_session_drafts.sql`（sessions 草稿标量结构化列 + `creation_session_draft_references` 有序引用子表，FK 级联对齐素材生命周期）；`SessionService.SaveDraft` 单一 verified write tx 原子替换（列 upsert + 引用整表重写 + tx 内 role/kind 校验）；creator-private 由 owner-scoped SQL 在查询层与命令层同时执行；`draft_updated_at IS NULL` = 从未保存，wire 恒为 `draft: null`。
- Desktop：生产 Workbench 布局（原型 6e465e8 Variant A：左 210px 私有会话列表 / 右连续工作区 / 底部固定 Composer）；Composer 内联 48×64 参考牌堆（hover/focus 原位右展、方向键、Delete、添加入口、超宽横向滚动 + 边缘渐隐）；能力控件向上展开（媒体/模型/模式/参数/时长）全部由 Capability Manifest 驱动；草稿自动保存（800ms debounce + 切换/卸载 flush）与重载恢复；manifest 失效值原样保留并以稳定「能力已变化」标记展示，绝不静默改写；无可用媒体 capability 时仍可编辑草稿并显示 reason/action 建议；提交按钮禁用（本切片无 Generation Task，不伪造提交成功）。

## 共享区域影响

无。未触碰 `renderer shared owners`（components/ui、lib、hooks）、`server/internal/` 共享子包（event/auditlog/authz 仅按既有 public seam 消费）；根 `contracts/` 为本切片的 primary contract owner，变更即本切片主题。App 层仅 `app/pages/creation-page.tsx` 组装根 wiring（AppShell 包装，符合 composition-root 职责）。

## 有意偏差（对照 6e465e8）

1. 左侧产品导航栏（60px 灵感/生成/资产）不入 Workbench：App Shell 已是统一导航 owner（ADR-0004），重复入口违反「不保留重复入口」。
2. 能力控件配色/字体走 globals.css 主题 token，而非原型硬编码 zinc 色值：原型是视觉层级/密度/交互基线，主题一致性与 WCAG AA 由设计系统 owner 负责。
3. 视频时长控件为 manifest 离散档位按钮（5/10s），非原型连续滑杆：manifest 只发布离散时长，滑杆会暗示未验收的连续能力。
4. 时长并入参数菜单而非独立触发器：V1 视频参数只有分辨率+时长，独立触发器留白过多（截图对照中说明）。
5. 空态不含模板卡片：Official Selection 属后续切片，原型模板卡为 fixture 资产不进生产。
6. 提交按钮禁用而非省略：保持原型版式；生成提交由 Generation Task 切片接管，界面不伪造成功。

## 验证证据

- Server：`scripts/test-creation-integration.sh` 全绿（真 PostgreSQL + MinIO、零 skip）：新增 `draft_flow_test.go`（保存/恢复往返、creator-private 404 矩阵、失败不留部分更新、素材删除级联、manifest 失效值原样往返、结构包络拒绝矩阵）、OpenAPI conformance 覆盖新端点与 `draft: null`；domain 纯单测（包络/角色-素材相容矩阵）。
- Desktop：`pnpm run test:component` 70 passed（新增 10 例：草稿恢复、自动保存 payload、失效值保留 + 菜单只列合法候选、manifest 不可用仍可编辑、无能力时的稳定建议、牌堆键盘等价、无伪造提交）；`test:unit` 137 passed（draft 客户端 URL/method/bearer/snake_case payload/fail-closed 解析）；i18n 资源契约测试通过；`typecheck` 与 `verify:architecture` 通过。
- Electron E2E smoke：`scripts/run-e2e.sh smoke` 19 passed —— tracer 扩展为「建会话 → 输入草稿自动保存 → 上传真实 PNG → 关闭应用 → 重启 → 服务端恢复草稿与素材」。
- 对照截图（960×600 / 1280×800）：`.scratch/177-creation-workbench-draft/proto-*.png` vs `production-*.png`；偏差见上。

## 明确不做

Generation Task/Specification/Result Slot/queue/usage/SSE、Provider 调用、提交动作、Electron Main/IPC 新 owner（零新增）。
