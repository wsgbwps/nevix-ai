# #177 高风险计划：可恢复 Composer 草稿（持久数据 + 授权）

Parent: #177 · Spec: #150 · Primary Domain: AI Creation · 最窄 owner: creation
（Server `server/internal/creation`、Desktop `features/creation`、contract `contracts/creation.yaml`）

## 持久数据

**Migration `0007_creation_session_drafts.sql`（up-only）**

1. `creation_sessions` 增加草稿标量列（结构化列，不用 JSONB——草稿不是 provider payload /
   versioned manifest / publication snapshot）：
   - `draft_prompt text NOT NULL DEFAULT ''`，CHECK `char_length <= 2000`（spec 图片/视频合同）
   - `draft_media_type text NULL`，CHECK `IN ('image','video')`；NULL = 未设置
   - `draft_manifest_version integer NULL`，CHECK `>= 1`；按保存时的 manifest 原样记录
   - `draft_model text NULL`，CHECK `char_length <= 128`
   - `draft_mode text NULL`，CHECK `char_length <= 64`
   - `draft_ratio text NULL`、`draft_resolution text NULL`，CHECK `char_length <= 16`
   - `draft_quantity integer NULL`，CHECK `BETWEEN 1 AND 4`
   - `draft_duration_seconds integer NULL`，CHECK `> 0`
   - `draft_updated_at timestamptz NULL`
   值域校验刻意宽松于当前 manifest：manifest 移除的历史值必须能原样保留（不静默替换/降级），
   合法性由提交时（后续切片）按 manifest 权威校验。
2. 新表 `creation_session_draft_references`：`session_id uuid FK→creation_sessions ON DELETE
   CASCADE`、`position integer CHECK >= 0`、`material_id uuid FK→creation_reference_materials
   ON DELETE CASCADE`、`role text CHECK IN ('reference','first_frame','last_frame','omni')`、
   `PK (session_id, position)`。排序是结构化列 + 主键约束；素材被删除时 DB 级联移除草稿条目
   （既有素材生命周期规则不漂移）。`material_id` FK 单独建索引（每个 FK 有匹配索引）。
3. 授权沿用行级所有权：所有草稿查询/写入都带 `owner_user_id = acting AND deleted_at IS NULL`
   谓词；不新增数据库角色，写事务继续走 `identity_app` + creation writetx 验证。

## 授权

- 新 route `PUT /creation/sessions/{sessionID}/draft` 挂 `RequireActiveUser`（与其他 session
  route 相同），handler 从 principal 取 creatorID；GET /creation/sessions/{sessionID} 响应内嵌
  `draft`（nullable）。creator-private 在查询层与命令层同时执行：
  - 他人（含 Admin、伪造 UUID）读/写草稿 = 与读/写 Session 相同的 404 `not_found` fail closed。
- 保存命令 `SessionService.SaveDraft`：一个 verified write tx 内完成（a）sessions 草稿列
  upsert（b）draft_references 全量替换（DELETE+INSERT）。任何失败回滚，无部分更新。
  结构校验（服务层，先于 tx）：role 枚举、references ≤ 4、reference 素材必须属于本 session
  （owner-scoped 查询解析 kind）、role-kind 相容（reference/first_frame/last_frame 仅 image）。
  不校验值是否在当前 manifest 内（见上）。

## 合同

- `contracts/creation.yaml`：新增 `putSessionDraft`（`SessionDraftInput`/`SessionDraft`
  schema、稳定错误沿用既有 vocabulary）；`getSession` 响应改为 `CreationSessionDetail`
  （`allOf CreationSession + draft`）。列表响应不含草稿。

## Desktop

- Workbench 生产布局（原型 6e465e8 Variant A）：左侧私有 Session 列表、右侧连续工作区、
  底部固定 Composer（内联 Reference 牌堆、能力控件向上展开）；移除 slice 06 顶部牌堆入口。
- 草稿自动保存（debounce + 切换/卸载前 flush）经 `PUT draft`；恢复经 GET session 内嵌 draft。
- manifest 驱动候选值；草稿中的失效值原值保留并显示稳定原因；无可用媒体 capability 时仍可
  编辑草稿并给出 reason/action 建议。本切片无提交：不创建 Generation Task，不伪造提交成功。

## 测试与验证门槛

- Server 真库集成测试（`NEVIX_CREATION_INTEGRATION_REQUESTED=1`）：creator-private 矩阵
  （creator A/B、Admin、伪造/已删除）、原子恢复（保存→读回一致；素材删除后引用条目消失；
  非法引用失败后原草稿不变）、manifest 失效值原样往返、OpenAPI conformance 覆盖新端点。
- Desktop public-surface component tests（挂载 `CreationWorkbenchPage` + 脚本化 ports）：
  草稿编辑→保存调用、重载恢复、manifest 失效值保留展示、无能力可编辑+行动建议、牌堆键盘
  等价（方向键/Delete/添加）、无伪造提交。HTTP adapter 轻量单测（URL/method/bearer/payload）。
- 最短 Electron E2E：创建会话→输入草稿→加素材→重启/重进→恢复断言。
- 无新增 Electron Main/IPC owner；共享区域无变更（不触碰 renderer shared owners、
  `internal/` 共享子包、根 contracts 之外文件）。

## 明确不做（本切片）

Generation Task/Specification/Result Slot、Provider 调用、提交按钮生效、SSE、usage。
