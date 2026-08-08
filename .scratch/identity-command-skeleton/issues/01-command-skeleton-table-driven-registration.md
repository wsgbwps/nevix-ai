# 01 — command 骨架与表驱动注册（CORS 同源派生）

**What to build:** identity Module 获得一个 `command` 骨架子包与一张静态路由表，此后「新增一个 trusted command」不再需要触碰 CORS、预检或错误信封：骨架提供唯一错误信封 writer（逐字节保留现有 `{"error":...,"message":...}` 格式）、统一的 decode/校验/错误映射/500 日志管线（泛型 `Handle` 与 `HandleWithRequest` 两个入口，共享私有实现）、`Route` 表、`Mount` 与 `MethodsByPath`。`Register` 改为声明路由表并由骨架挂载：路由按 entry 的 `Public` 零值安全规则决定是否挂 Bearer guard，每个 path 自动获得 OPTIONS 孪生，preflight 的 `Allow-Methods` 从表逐路径派生（删除硬编码）。两个现有命令**以其现有 handler 原样入表**——外部可观察行为零变化，包括 PR #28 的预检语义（白名单 204+头部、未知 origin 落穿无 CORS 头）。决策全貌见同目录 `plan.md`。

**Blocked by:** None — can start immediately

**Status:** resolved — [PR #29](https://github.com/wsgbwps/nevix-ai/pull/29) squash-merged to `main` as `db6c3ec7944a3158df8d04f22e4009de4eba7915` on 2026-08-08

- [x] 骨架单测打穿管线：decode 失败 → 400 invalid_request；Validate 失败 → 按映射成形；域错误经 mapError 成形（含 Headers 透传）；未知错误 → 500 internal_error 并记日志；成功 → 声明的状态码 + JSON body；信封字节形状与现网一致
- [x] 挂载派生测试：每个 path 自动注册 OPTIONS 孪生；`Allow-Methods` 按 path 聚合派生；`Public` 缺省（零值）的路由挂 Bearer guard、显式公开的不挂；**测试以 chi Group 方式挂载（复制 main.go 的生产形状）**，覆盖白名单与未知 origin 两种预检
- [x] Register 中不再出现显式 OPTIONS 注册行与 `"POST, OPTIONS"` 硬编码（grep 验证）
- [x] 现有全部测试（transport、create_organization 集成、契约一致性、RLS、outbox、mail-smoke）在不改断言的前提下保持绿色；仅允许适配中间件构造签名
- [x] 组合面契约四件套（LoadConfig / NewModule / Register / RunWorkers）签名零变化

## Comments

- 2026-08-08：验收完成。`go vet ./... && go test ./...` 全绿；更新后的 PR 检查 E2E Smoke Suite 与 Supabase stack + GoTrue mail smoke 全绿；参数化 chi path 的多方法 `Allow-Methods` 回归已由挂载测试锁定。