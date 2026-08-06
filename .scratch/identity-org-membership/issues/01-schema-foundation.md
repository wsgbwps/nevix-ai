# 01 — Schema 基座：profiles / organizations / memberships + RLS/GRANT

**What to build:** 前置切片的数据基座。client 可读的 profiles / organizations / memberships 三表进入 `public` schema（expand-only migration，全程 ENABLE RLS）：profiles 以 user_id 为主键（FK auth.users ON DELETE CASCADE）、display_name trim 后 1–50 字符拒纯空白不唯一、不加 avatar_path 列；organizations 仅 id/name/时间戳；memberships 带 role（owner/admin/member）与 status（active/ended）CHECK、两张部分唯一索引（活跃成员唯一、活跃 Owner 唯一）。授权判断收敛为三个 identity schema 的 security definer helper（is_active_member / has_org_role / shares_active_org，search_path=''、对 PUBLIC/anon/authenticated 撤销 EXECUTE）；新建单一 identity_app LOGIN 角色并对五张 public 表中的这三张加 permissive policy；identity.directory 只读视图引用 auth.users 且 GRANT SELECT 仅 identity_app。RLS 策略：profiles 本人或活跃同组织成员可见、本人行可 INSERT/UPDATE；organizations 活跃成员可见；memberships 本人行（含已结束）+ 本组织活跃行。所有外键与 RLS 查找用列配齐索引。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 声明式 schema 更新并生成 migration，过 advisors 与 migration-history 检查
- [ ] 三表、三 helper、identity_app 角色、identity.directory 视图与全部 GRANT/RLS 策略按 spec 与 ADR-0008 落地
- [ ] RLS 集成测试（真实 anon/authenticated token 直连 PostgREST）证明跨组织隔离
- [ ] RLS 集成测试证明 client 只能写本人 profile 行，对 organizations/memberships SELECT-only
- [ ] migration 属 CI 门禁路径，走 feature branch + PR
