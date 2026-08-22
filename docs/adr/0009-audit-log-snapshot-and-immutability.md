# ADR-0009: Audit Log 快照归属与不可变性

## 状态

已接受 — 2026-08-05

## 背景

Audit Log 行需要呈现 actor 与 target 的显示名。直觉设计是存 user_id 加 FK、展示时 join profiles——但显示名可改、用户可删，历史行会随之失真甚至悬空。审计的价值恰在于反映"当时的事实"。

## 决策

- actor/target 的 user_id 与显示名在写入时快照进审计行，刻意不加 FK；user_id 充当 non-login stable identifier，用户删除后历史行仍完整可读。
- metadata 为 jsonb；action 为 text，由 Go 单一写入方校验合法值，不设 DB CHECK。
- 不可变性靠 GRANT 落地：client 角色对 audit_logs 无任何写权限，identity_app 持 SELECT,INSERT,DELETE 但无 UPDATE；不加触发器或 WORM 机制。
- 保留策略：identity_app 每日 sweep 删除 365 天前的行；导出 = Desktop 经 RLS 直读分页 + 本地写文件，不建服务端导出接口。

## 修订 — 2026-08-22（单租户私有化）

- organization 维度随单租户移除：`audit_logs` 去 `organization_id` 及其 FK；写入时快照、无 actor/target FK、无 UPDATE 授权、action 由 Go 单一写入方校验、365 天滚动 sweep 等决策全部继续有效。
- 客户端 RLS 直读取消：读取与导出改为经 Go API 的 admin-only 分页端点；导出仍是 Desktop 本地写文件，不建服务端导出接口。
- 背景见 [ADR-0013](0013-onprem-single-tenant-delivery.md) 与 [ADR-0015](0015-single-tenant-user-system-and-go-authorization.md)。

## Considered Options

- **FK + join 派生显示名**：改名会回改历史、删用户留下悬空引用或级联删历史，与审计语义冲突；否决。
- **action 列加 DB CHECK**：Go 是唯一写入方且已校验；CHECK 使每新增 action 都要 migration，把应用词汇冻结进 schema；否决。
- **触发器禁止 UPDATE/DELETE**：GRANT 已提供同等约束，且 retention sweep 需要合法 DELETE 通道；引擎级机制留待出现第二个写入方时再议。

## 后果

- 历史行永久反映写入时刻的显示名；修改 display_name 不回溯历史（新行用新名）——这是语义特性而非缺陷。
- 365 天滚动保留意味着审计不是合规归档；出现更长保留期的合规诉求时重开本 ADR。
- 不可变性的强度等于角色授权纪律：任何"临时授 UPDATE 修数据"的运维操作都破坏本决策。
