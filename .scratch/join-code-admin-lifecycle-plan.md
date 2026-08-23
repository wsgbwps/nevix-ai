# 加入码生命周期（Admin 签发/查看/吊销）— #120 切片计划

决策链：ADR-0015（2026-08-23 修订）、[.scratch/join-code-self-registration-plan.md](./join-code-self-registration-plan.md)、issue #99（spec）、issue #120（本切片）。

## 边界

本切片只交付 **Admin 侧治理**：schema、admin 端点、OpenAPI 契约、设置区 UI、Seam A 集成测试、E2E。
`POST /identity/register`（自注册消费端点）与首启向导是后续独立切片，不在本切片内。

- Primary Domain：Server identity；次要：Desktop user-management
- 固定点：`main@23f9737`；验收边界：issue #120 六条 acceptance criteria

## Server

- Migration `0003_join_codes.sql`（up-only）：`public.join_codes`（id/code 唯一/label 默认 ''/created_by FK/created_at/revoked_at）；`GRANT SELECT, INSERT, UPDATE`（无 DELETE——吊销即 UPDATE revoked_at，行永不删）
- 新责任簇子包 `internal/identity/joincodes/`：`Create`（活跃上限 3：写事务内 `SELECT ... FOR UPDATE` 锁活跃行计数；Crockford base32 8 位随机码，冲突重试）、`List`（活跃码明文列表，pool 读）、`Revoke`（`UPDATE ... WHERE revoked_at IS NULL`，RowsAffected=0 → 404 `join_code_not_found`）
- 审计：`join_code_created` / `join_code_revoked`（audit 词表扩展，action 列为 text 无 migration；target 为 NULL，metadata 记 join_code_id + label）
- 路由：`POST|GET /identity/admin/join-codes`、`DELETE /identity/admin/join-codes/{joinCodeID}`，全部 `GuardAdmin` + 默认密码门禁

## 契约

- `contracts/identity.yaml` 三端点（409 `too_many_active_join_codes`、404 `join_code_not_found`、400 `invalid_label`）+ `contracts/openapi.yaml` $ref；契约一致性测试自动覆盖新响应

## 桌面端

- user-management feature 内新增「加入码」卡片（设置区用户管理 section 同屏，卡片位于用户列表之下）：建码（可选 label，≤128 字符）、活跃码明文列表（码/label/创建时间）、吊销确认
- api client 扩展、`use-join-codes` hook、i18n `joinCodes` 词条（zh/en 成对）+ 错误码词条 + 审计动作词条

## 测试

- Seam A `join_codes_test.go`：创建→列表见明文+审计行；上限 3（第 4 个 409；吊销后可再建）；吊销→列表消失+审计行；重复吊销/未知 id/畸形 id → 404；member 403 / 未认证 401（三端点）；契约断言
- 迁移证据测试扩展：join_codes 进 baseline 表清单与 GRANT 断言（SELECT/INSERT/UPDATE，断言无 DELETE）
- harness `resetUserState` truncate 扩入 join_codes；`scripts/test-identity-integration.sh` 哨兵清单加新测试
- Seam B `admin-join-codes.spec.ts`：admin 建码、见明文、吊销（非 @smoke，随 full E2E 走）

## 验收检查单（对应 issue #120）

1. Admin 可创建加入码（可选 label），创建后立即在活跃码列表中看到明文码 → Seam A + E2E
2. 活跃码上限 3：达上限再创建 409 `too_many_active_join_codes`，吊销后可再建 → Seam A
3. Admin 可吊销活跃码；吊销后列表不再显示 → Seam A + E2E
4. 端点对 member 403、未认证 401；`join_code_created`/`join_code_revoked` 落 Audit Log → Seam A
5. 新端点全部进 OpenAPI 契约；Seam A 覆盖生命周期、上限、guard → 契约 diff + Seam A
6. 桌面端 E2E：admin 建码、见明文、吊销 → Seam B
