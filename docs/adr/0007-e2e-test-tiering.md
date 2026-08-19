# E2E 测试分层：开发循环跑 Smoke，候选 SHA 跑 Full E2E

Desktop 的 Electron E2E 此前只有一条本地命令：四次构建加全部 spec 串行执行，CI 完全不跑——认证主链路没有任何自动门禁，本地每次全量又成为瓶颈。我们把 E2E 分为两层：**Smoke Suite**（spec 以 `@smoke` tag 标注，只做一次 test 模式构建，墙钟预算 10 分钟）用于开发循环和需要提前反馈的 pull request；**Full E2E Suite**（配置失败构建加全部 spec）在触及 Desktop 或 Auth Harness 输入的 `ready/<sha>` candidate push 与手动 `workflow_dispatch` 时执行，作为进入 `main` 前的信号。始终运行的 `CI gate` 按路径调用相应层级，文档和本地开发配置改动不启动 E2E。CI 中 Auth Harness 环境缺失必须 fail 而不是静默 skip（Linux runner 只有 basic_text 后端，需 `NEVIX_TEST_FORCE_BASIC_TEXT_STORAGE=1` 才会真正执行 Session 持久化路径）。当前 GitHub Free 私有仓库不开 required status check；本地 landing 与 hooks 防止误操作，但不构成服务器端不可绕过控制。若服务器端门禁可用，只应将 `CI gate` 设为必需检查。

## Considered Options

- **所有改动跑全量**：未触及 Desktop 或认证链路的改动会付全额墙钟，正是路径分类要消除的成本。
- **nightly 全量**：外部依赖（GoTrue 邮件链）已由 mail-smoke-ci 在 `supabase/**` 变更时覆盖；单人项目夜里跑红无人响应。
- **快照 userDataDir 复用登录态**：应用恢复 Session 前必走 refresh，refresh token 一次性轮换，多个并行 worker 从同一份快照启动必然竞态——否决。若实测 UI 登录成为瓶颈，改用 `NEVIX_TEST_*` 环境变量注入、每测试独立身份的方案。
- **五个具体 required status checks**：路径过滤会使未触发工作流保持 Pending，不能作为 path-aware candidate 的稳定门禁。若服务器端门禁可用，只设最终 `CI gate` 为必需检查；当前仓库仍不开 required status check。

## Consequences

- 并行化（文件级、`workers=2`）作为独立切片随后落地；`configuration.spec.ts` 因绑定专用构建保持串行；登录态复用挂起待实测。
- `ready/<sha>` 事件只进入 `CI gate` 并按路径调用可复用的 Full E2E Suite；可选 PR 调用 Smoke Suite；普通 `main` push 不重复执行专用 workflow，Full E2E 不增加定时任务。

> **2026-04-30 更新**：`ready/<sha>` 路线已由 [ADR-0011](0011-pr-based-delivery.md) 的 PR 路线取代。现行分层：PR 触及 E2E 相关路径跑 Smoke；需要全量时给 PR 打 `full-e2e` 标签升级为 Full（`workflow_dispatch` 亦可手动触发）；合并后的 `main` push 不再跑任何 E2E（PR 已验证同一棵代码树）。
- 词汇以本 ADR 为准：**Smoke Suite**（开发或 PR 反馈子集）、**Full E2E Suite**（相关候选的全量门禁）、**Auth Harness**（`tests/auth/harness` 下的一次性 Supabase 栈）；它们是测试基础设施词汇，不进产品语言 CONTEXT.md。
- 名不副实的 `test:auth`（实际跑全量）正名为 `test:e2e` / `test:e2e:smoke`。

> **2026-08-19 更新**：E2E 触发路径细化——`apps/desktop` 下的文档与根级 markdown、`test-results/` 本地产物，以及只由 Desktop CI 执行的 `tests/unit`、`tests/component` 不再触发 E2E（仍归 Desktop CI 门禁）。另增 `skip-e2e` PR 标签：路径分类命中 E2E 但确无运行必要时可跳过 Smoke；与 `full-e2e` 同时存在时 `full-e2e` 优先，显式升级请求不被静默吞掉。
