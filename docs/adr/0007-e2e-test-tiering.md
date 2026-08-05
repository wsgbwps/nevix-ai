# E2E 测试分层：PR 跑 Smoke Suite，main 跑 Full E2E Suite

Desktop 的 Electron E2E 此前只有一条本地命令：四次构建加全部 spec 串行执行，CI 完全不跑——认证主链路没有任何自动门禁，本地每次全量又成为瓶颈。我们把 E2E 分为两层：**Smoke Suite**（spec 以 `@smoke` tag 标注，PR 触发，只做一次 test 模式构建，墙钟预算 10 分钟）作为合并前信号；**Full E2E Suite**（配置失败构建加全部 spec）在 main push 与手动 workflow_dispatch 时执行，作为合并后信号。CI 中 Auth Harness 环境缺失必须 fail 而不是静默 skip（Linux runner 只有 basic_text 后端，需 `NEVIX_TEST_FORCE_BASIC_TEXT_STORAGE=1` 才会真正执行 Session 持久化路径）。不开 GitHub required status check：单人仓库、PR 由 AI 审阅，红绿可见即可，保持零日常操作。

## Considered Options

- **PR 上跑全量**：每个 PR 都为未触及认证链路的改动付全额墙钟，正是本次要消除的痛点。
- **nightly 全量**：外部依赖（GoTrue 邮件链）已由 mail-smoke-ci 在 `supabase/**` 变更时覆盖；单人项目夜里跑红无人响应。
- **快照 userDataDir 复用登录态**：应用恢复 Session 前必走 refresh，refresh token 一次性轮换，多个并行 worker 从同一份快照启动必然竞态——否决。若实测 UI 登录成为瓶颈，改用 `NEVIX_TEST_*` 环境变量注入、每测试独立身份的方案。
- **required status check**：与零日常操作约束冲突；误合红色 PR 的代价是紧接一个修复 PR，可接受，需要时两分钟可补开。

## Consequences

- 并行化（文件级、`workers=2`）作为独立切片随后落地；`configuration.spec.ts` 因绑定专用构建保持串行；登录态复用挂起待实测。
- 词汇以本 ADR 为准：**Smoke Suite**（PR 门禁子集）、**Full E2E Suite**（全量）、**Auth Harness**（`tests/auth/harness` 下的一次性 Supabase 栈）；它们是测试基础设施词汇，不进产品语言 CONTEXT.md。
- 名不副实的 `test:auth`（实际跑全量）正名为 `test:e2e` / `test:e2e:smoke`。
