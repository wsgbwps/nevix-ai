# 加入码自注册 — 实施计划（切片 1/2）

背景：issue #99 迁移完成后的成员进人痛点（100–200 人逐个建号不可扩展）。决策出自 2026-08-23 grilling 会话；[ADR-0015](../docs/adr/0015-single-tenant-user-system-and-go-authorization.md) 已修订（账号生命周期·建号双通道）。

## 范围

- Primary Domain：Server identity；次要：Desktop authentication / user-management
- 一条垂直切片：Schema → server 端点 → OpenAPI 契约 → 桌面端 → 测试

## Schema（up-only migration）

- 新表 `public.join_codes`：
  - `id` uuid PK、`code` text NOT NULL UNIQUE（Crockford base32 8 位）、`label` text NOT NULL DEFAULT ''（提示贴到哪个群的备注）、`created_by` uuid NOT NULL REFERENCES users(id)、`created_at` timestamptz NOT NULL DEFAULT now()、`revoked_at` timestamptz NULL
- 活跃码 = `revoked_at IS NULL`；活跃上限 3 由 service 层在写事务内计数强制
- GRANT：identity_app SELECT / INSERT / UPDATE（吊销 = UPDATE revoked_at）
- 码可复用（共享秘密），不随注册消耗；吊销才失效

## Server 端点（全部进 contracts/openapi.yaml）

- `POST /identity/register`（公开）：`{email, password, display_name?, join_code}` → 201，LoginResponse 形态（token / expires_at / user）；user 为 member、active、`must_change_password=false`
  - 错误：`invalid_join_code`（无活跃码与码错统一答案，不给枚举面）、`email_taken` 409、`password_too_short` 400、`invalid_email` 400；per-email 进程内限速（复用登录 limiter 模式）
  - 单一写事务：锁定活跃码行校验 → INSERT user → 审计 `user_self_registered` → 发 session
- `POST /identity/admin/join-codes`（RequireAdmin）：`{label?}` → 201 `{id, code, label, created_at}`；活跃数达上限 → 409 `too_many_active_join_codes`；审计 `join_code_created`
- `GET /identity/admin/join-codes`（RequireAdmin）→ 活跃码列表（code 明文可见 + created_by / created_at / label）
- `DELETE /identity/admin/join-codes/{id}`（RequireAdmin）→ 吊销；不存在或已吊销 → 404 `join_code_not_found`；审计 `join_code_revoked`
- 席位闸门：license 实现落地后与管理员建号共用同一闸门（ADR-0013 冻结语义；当前无实现，不预编码）

## 审计动作

- `join_code_created` / `join_code_revoked` / `user_self_registered`（audit 包 validActions 扩展；action 列为 text，无 migration）

## 桌面端

- 登录屏新增「注册」入口（始终可见；提交后由 `invalid_join_code` 揭示注册关闭/码错）；表单：email、密码、加入码、显示名（可选）；成功后与登录同路径进 app（无强制改密）
- Admin 设置 user-management 区新增「加入码」卡片：创建（可选 label）、活跃码列表（明文）、吊销；i18n 词条（userManagement 命名空间）

## 测试

- Seam A：注册成功（member/active/无 must_change_password/session 即发/审计行）；无活跃码与码错同答 `invalid_join_code`；`email_taken`；限速；活跃上限 3；吊销后再注册被拒；guard（register 公开、admin 端点对 member 403）
- Seam B：注册 → 进 app；admin 建码/吊销；吊销后注册失败文案

## 非目标

- 首启设置码向导（切片 2/2）；席位闸门实现；邮件验证（无通道）；注册开关（吊销全部码即关闭）
