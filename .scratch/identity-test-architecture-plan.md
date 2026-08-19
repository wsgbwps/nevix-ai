# Identity 测试架构：归属整理与集成门禁收紧

来源：architecture-review 候选 2 经 grilling 会话（Q1–Q27 + 修正声明）确认的 shared understanding。
本文件是实施计划与验收记录，非 ADR（决策可逆、局部；第二 Module 采纳出现争议时再升级为 ADR）。

## 决策摘要

1. 测试按两个正交维度分类：**边界决定摆放，资源决定命名与运行方式**。
2. `identity/integrationtest/` 是 **Identity integration suite**（Module、Worker、GoTrue/RLS、SMTP、OpenAPI 契约 seam），不是"所有真库测试"的收纳目录。
3. package-local real-resource tests 留在 owning package；Outbox FK index 测试迁入 `outbox/`；统一 `*_integration_test.go` 命名（资源维度标签，无 build tag）。
4. 测试支持只存在于测试编译单元：删除独立 `mailpittest` package，client 合并为 `mailpit_support_test.go`；harness / JWKS / 共享 transport wiring 拆为具名 `_test.go`。不拆子包，不建共享 testkit。
5. 各 package 保留极小本地环境 helper（约 10 行），统一 skip/fail 语义，不强求共享实现：
   - 未请求集成（无 `NEVIX_IDENTITY_INTEGRATION_REQUESTED=1`）且缺环境 → skip；
   - 已请求集成且缺环境 → fail；
   - 环境存在但无效 → fail。
6. 专用门禁是唯一正式集成入口：递归 `./internal/identity/...`、`-race -p 1`、requested 模式零 skip、类别级 PASS sentinel（已承认的残留维护点）。
7. Harness 凭据身份显名：`fixturePool`（owner fixture/assertion，`NEVIX_DATABASE_URL`）与 `runtimePool`（`identity_app` 运行时，`NEVIX_IDENTITY_DATABASE_URL`）；`startup_identity_test.go` 可显式传入应被拒绝的凭据（其职责即证明拒绝）。
8. 文档：根 `README.md` + `server/AGENTS.md`；不写 ADR；不改 `server/CONTEXT.md`。
9. Q6 不变集收窄：产品契约、DB schema/RLS/事务语义、断言语义、生产构建图不变；测试发现方式、package-local skip/fail 策略、门禁执行证据、文件摆放与命名被本任务显式改变。

## 变更范围

### 包含

- `server/internal/identity/mailpittest/` 删除；client 并入 `integrationtest/mailpit_support_test.go`。
- `integrationtest/` 内：`harness_test.go`（requireEnv、harness、worker/module 生命周期）、`mailpit_support_test.go`（client + docker/等待 helper）、`jwks_server_test.go`（ES256 JWKS server）、`transport_support_test.go`（newTransportHandler、commandRouter）。
- harness 字段改名 `pool`→`fixturePool`、`runtime`→`runtimePool`。
- `integrationtest/outbox_fk_index_test.go` → `outbox/outbox_fk_index_integration_test.go`（package outbox，本地 env helper）。
- `invitations/accept_query_plan_test.go` → `accept_query_plan_integration_test.go`；`verification/code_issuance_query_plan_test.go` → `code_issuance_query_plan_integration_test.go`；env 检查升级为 requested-mode 语义。
- `scripts/test-mail-smoke.sh`：单一递归 `go test -C server -race -count=1 -p 1 -v ./internal/identity/...`；sentinel 增加 query-plan 两项与 outbox FK 一项；保留零 skip 断言。
- 根 `README.md` 与 `server/AGENTS.md` 记录摆放契约。

### 排除（越界即停）

- 任何 Identity 生产逻辑；schema/migration/RLS/GRANT；HTTP/OpenAPI 契约内容。
- 测试断言、超时、轮询间隔、业务 fixture 语义。
- build tags、共享 testkit、新架构 linter、`integrationtest` 子包拆分。
- CI classifier/workflow 修改；新 ADR；`server/CONTEXT.md`。
- 候选 1/3/4 相关清理。

## 验收证据（Q24）

1. 移动前后顶层测试集合不变（`go test -list '.*' ./internal/identity/...`，基线 104）。
2. `(cd server && go vet ./... && go test ./... && go build ./cmd/server)` 通过。
3. `make test-identity-integration`（`-race -p 1`）通过且零 skip。
4. package-local 三个 query/schema-plan 测试均出现在 PASS sentinel。

> 本地执行记录（2026-08-19）：本机存在用户 2 小时前启动的 nevix-ai Supabase 开发栈且无 harness 锁文件；
> harness 的共享状态保护按设计拒绝运行（不触碰非自有栈）。证据 3/7 转由 PR 的 Identity CI 在干净 runner
> 上执行 `make test-identity-integration` 承担（delivery.md：PR checks 即实际门禁）。绝不对用户开发栈执行
> db reset 或 --no-backup 清理。
5. 生产二进制无测试支持 import；Mailpit helper 只存在于 `_test.go`。
6. `git diff --name-status` 只覆盖声明路径。
7. PR 的 CI gate 按现有 classifier 完整通过。

## 已核实事实

- `server/` 全树无 `t.Parallel()`；`-p 1` 为前瞻规则，不触及现有测试。
- `mailpittest` 仅被 `integrationtest` 消费；client 只依赖标准库。
- 现有两批 go test 调用 + 测试名正则；第二批（query-plan）无零 skip 证明——本任务修复。
