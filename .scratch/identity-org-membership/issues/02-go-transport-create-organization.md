# 02 — Go 传输基座 + CreateOrganization

**What to build:** Go 侧 Bearer JWT 传输基座与前置切片唯一命令。JWT/JWKS 验证作为 internal/identity Module 私有能力落地（ES256/P-256/kid 缓存）；CORS 按环境白名单、无 Origin 放行、永不通配。CreateOrganization 命令：客户端生成 org id 作幂等键（冲突且属同一 User 则返回既有组织），单事务保证 organization 行与首任 Owner membership 的原子性；命令经 identity_app 角色执行。新端点一律 Bearer JWT，JWT 失效返 401；同步变更返 200 + 受影响资源最小表示；错误信封沿用 {error, message}。openapi 契约新增对应条目，响应级对照校验升级为测试断言（条件已触发）。contracts/openapi.yaml 变更在 PR 描述中 call out 影响与测试。

**Blocked by:** 01 — Schema 基座：profiles / organizations / memberships + RLS/GRANT

**Status:** merged — [PR #25](https://github.com/wsgbwps/nevix-ai/pull/25) 经 mail-smoke CI 门禁（覆盖 `server/**` 与 `contracts/**`），merge commit 8548843

- [x] JWKS 验证（ES256/P-256/kid 缓存）集成测试通过，失效 JWT 返 401
- [x] CreateOrganization 集成测试：客户端 id 幂等（重试返回既有组织）、org + 首任 Owner 原子性
- [x] CORS 按环境白名单生效，无通配
- [x] openapi 契约条目与响应级对照校验断言落地，契约只增不改
- [x] server/ 与 contracts/ 属 CI 门禁路径，走 feature branch + PR
