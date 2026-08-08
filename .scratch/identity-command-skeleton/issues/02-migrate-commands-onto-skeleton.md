# 02 — 两命令迁上骨架，信封单一化

**What to build:** CreateOrganization 与 IssueVerificationCode 从各自手写的 `ServeHTTP` 迁到 command 骨架：业务函数签名收敛为 `func(ctx, req) (resp, error)`（verification 经 `HandleWithRequest` 用两行闭包提取 client IP）；字段校验与 normalization 移入请求类型的 `Validate() *command.Error`；每域子包一个 `mapError` 把域 sentinel 映射为 `command.Error`；cooldown sentinel 升级为携带 retryAfter 的 typed error，`Retry-After` 头经 `Error.Headers` 输出。`writeCreateError` / `writeIssueError` 删除，全 Module 只剩骨架一处信封实现。完成后新增一个 trusted command 的成本 = 一行路由表 entry + 业务函数 + 请求类型。决策全貌见同目录 `plan.md`。

**Blocked by:** 01 — command 骨架与表驱动注册（CORS 同源派生）

**Status:** in-review — [PR #32](https://github.com/wsgbwps/nevix-ai/pull/32)

- [ ] grep 不到 `writeCreateError` / `writeIssueError`；信封实现全 Module 唯一（骨架私有 writer）
- [ ] 现有六条字段校验规则（id/name 非空、UUID 形态、name 非 blank、email 归一化与形态）行为与原实现逐条一致，且 normalize 先于校验
- [ ] cooldown 响应仍携带正确的 `Retry-After` 秒数；429 三态（cooldown_active / email_rate_limited / ip_rate_limited）的信封与状态码不变
- [ ] Bearer guard 仍只挂在 organizations 路由；verification-codes 保持公开（`Public: true` 显式豁免）
- [ ] 现有集成测试、契约一致性测试与 mail-smoke 不改断言不红（回归网证明行为保持）
- [ ] 迁移演示：向评审者展示「新增一个假设命令」只需一行表 entry + 业务函数 + 请求类型，无 CORS/OPTIONS/信封代码

## Comments
- 2026-08-08：实现完成，等待 PR #32 审查与 CI。`cd server && go vet ./... && go test ./...` 通过；live mail-smoke 已跑过变更命令（签发、冷却含 `Retry-After`、组织 Bearer/CORS 与契约）并通过。该次套件随后因本地 Supabase 数据库在无关 Outbox/RLS 用例期间消失而失败；后续干净启动又受 Supabase CLI/Realtime `DB_HOST nxdomain` 阻断，保留 CI 作为 live 套件门禁。
