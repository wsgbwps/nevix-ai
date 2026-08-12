# AI 实现 feature 后的评审—修复收敛流程

> 研究日期：2026-08-12
> 问题：AI 完成 feature 后，如何让独立会话的 code review、修复与复审有边界地收敛，而不是把每轮意见都当作必须重做？

## 结论与适用范围

没有找到一份把「AI 作者 + 多会话评审」规定为单一行业标准的规范；下列流程是把 Google
的代码评审准则、GitHub 的 PR/门禁语义和本仓库现有契约组合得到的**项目建议**，不是伪称的
行业共识。共同的直接证据是：评审目标是持续改善代码健康而非完美；小而自包含、带测试的
变更更容易彻底审查；AI 输出必须由人理解、审查并以自动化工具验证。
[Google Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html)
[GitHub Copilot 最佳实践](https://docs.github.com/en/copilot/get-started/best-practices)

本仓库已要求 `main` 经 PR 合并且合并前通过 CI（`README.md:256–261`）。`CI gate` 在 PR
上按路径挑选 Desktop、Server、Mail 与 E2E Smoke，并在汇总 job 中拒绝所需 job 的非成功结果
（`.github/workflows/ci-gate.yml:3–6, 39–75, 103–144`）。但 ADR 明说**当前未在 GitHub
启用 required status check**（`docs/adr/0007-e2e-test-tiering.md:1–10`）；因此“远端权威门禁”是
应采用的目标状态，不能把当前可见的绿灯误说成平台强制。GitHub 的语义是：一旦配置为
required，检查必须在最新 commit SHA 成功，旧 SHA 的成功不算。
[GitHub required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)

## 可核实的实践证据

- **作者 preflight 与小批量。** Google 将一个最小、自包含、含相关测试、合入后仍正常工作的
  改动定义为合适粒度；小 CL 更快且更彻底，过大可被要求拆分。
  [Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html)
  因此 AI 作者也应在请求正式评审前自行读最终 diff、运行最小相关检查、写明行为/风险与测试
  覆盖；这是对上述原则及本仓库 final-state 要求的**推导**，不是 Google 对 AI 的直接规定。
  本仓库的本地记录还要求检查与 review 绑定同一 diff，任何随后代码编辑都会使二者失效
  （`docs/specs/final-state-evidence.md:9–26, 41–60`）。
- **Draft 的边界。** GitHub 将 draft 定义为尚需变更的状态，不能合并；转为 ready 才是请求
  反馈/触发 code owner review 的动作，收到需处理反馈也可转回 draft。
  [GitHub Draft PR](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/changing-the-stage-of-a-pull-request)
  GitHub 对 Copilot 的 lifecycle 教程进一步给出 draft 顺序：先处理高置信的正确性、安全性与
  明显可维护性问题，再 ready 给人类评审。
  [Copilot PR lifecycle](https://docs.github.com/en/copilot/tutorials/use-copilot-code-review-across-the-pull-request-lifecycle)
- **意见并非同等强制。** Google 建议明确标注严重性：required change 与 `Nit`、`Optional`、
  `FYI` 分开，避免作者误把所有意见当强制。
  [评论写法](https://google.github.io/eng-practices/review/reviewer/comments.html)
  它同时要求在整体代码健康确定改善时批准，而非为不完美无限延迟；个人风格不能单独阻塞。
  [评审标准](https://google.github.io/eng-practices/review/reviewer/standard.html)
  GitHub 还说明 `Request changes` 仅在 ruleset/branch protection 配置后才真正阻止合并；评审
  标签与远端规则必须同时明确。
  [required reviews 的实际语义](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews)
- **AI 的边界。** GitHub 明确 Copilot 可能出错，建议人先理解并仔细审查建议，再用测试、lint、
  code scanning 等工具验证；其 code review 还会排除部分依赖管理、日志、SVG 文件，且自动 PR
  review 默认不一定覆盖后续 push。
  [验证 AI 工作](https://docs.github.com/en/copilot/get-started/best-practices)
  [Copilot review 范围](https://docs.github.com/en/copilot/concepts/agents/code-review)
  这证明 AI review 是线索和第二视角，不是正确性证明；复杂的安全、隐私、并发等部分还应有
  合格的人类评审者。
  [Google：评审资格](https://google.github.io/eng-practices/review/reviewer/looking-for.html)
  GitHub 对 AI 生成代码的次序是先跑编译/测试与静态分析，再核对是否符合需求和架构；这直接
  支持 preflight 的先验检查。
  [Review AI-generated code](https://docs.github.com/en/copilot/tutorials/review-ai-generated-code)

## 推荐的有界流程（项目推导）

1. **先定边界。** 一个 feature 切成可独立运行、可回滚的垂直 slice；PR 描述写 acceptance
   boundary、非目标和相关测试。跨安全、持久化或架构边界先停线并走本仓库既定计划/ADR 路径。
2. **实现者 preflight。** AI 实现后，先运行最小相关的 lint/build/test/静态分析，再独立检查
   最终 diff 是否符合 PR 描述、需求与架构；失败即修复，不发 ready。以 draft 公开已知风险并
   请求一轮 AI advisory review，优先处理高置信 correctness/security/maintainability 反馈，
   但不得把“无评论”当通过。
3. **正式评审。** preflight 通过且没有已知 blocker 才 ready。每条意见必须带证据并归为：
   `BLOCKER`（行为、安全、数据、接口、测试或既定架构会变坏）、`NON-BLOCKING`（可延后）或
   `QUESTION`。无类别、无可验证理由的意见先澄清，不直接改码。
4. **只复审变更集。** 作者一次性处理同一批 blocker，说明“修复/有证据地拒绝/转 follow-up”；
   每次代码改动后重跑受影响检查。独立会话只审新的 diff 和仍开放的 blocker，不重开已关闭的
   品味争论。仅在跨 service/package 的多文件更新、安全或数据敏感变更、或大批建议后请求
   AI re-review；这是 GitHub 对 Copilot 的明确建议。若改动扩大 acceptance boundary，转回
   draft 并重新做完整评审。
5. **收敛并关闭。** 所有 blocker 已有可追溯解决或明确授权的拒绝；最终独立评审针对最新 SHA
   明确“无 blocker”；最后一次本地相关检查通过且与最终 diff 绑定；PR 的 `CI gate` 成功。
   若将来启用 GitHub required check，还必须是最新 SHA 的远端通过结果，才可合并。

**Stop-the-line / stop-review 条件：**任一 preflight、CI 或 required check 失败立即停止评审并
修复；发现安全/数据/架构问题、验收边界改变、评审者无资格判断或连续两轮出现新的同类
blocker 时，停止“再叫一个 AI 评审”，改为拆小 slice、补测试/设计说明，并由代码所有者作决定。
反过来，满足第 5 步即停止 review；未解决的 `Nit`/`Optional` 记录为 follow-up，不以“也许还能
更好”阻塞。这是对 Google “改善而非完美”原则的可操作化，而非自动放宽 blocker。

## 反模式与证据缺口

- 把多会话 AI 的“没有发现”当测试、人工批准或远端门禁；官方文档只承诺其会给反馈，并明确
  要验证，未给出可替代人工审查的保证。
- 每个建议都修、每次修复都从头全量审：这抹平严重性，也违反小而聚焦变更的可审查性。
- 以本地旧绿灯或旧 SHA 结束循环；GitHub 对 required check 和本仓库 final-state 都要求最新
  状态的证据。

可用的一手资料没有提供“第几轮 AI review 后必然收敛”的普适阈值，也没有给出本仓库 AI
review 的误报/遗漏率。上文“两轮同类 blocker 即停线”是为防止无界循环设定的项目策略，需在
实际 PR 数据积累后调整。

## Sources

- [Google Engineering Practices：Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html)（官方工程实践，2026-08-12 查阅）
- [Google Engineering Practices：The Standard of Code Review](https://google.github.io/eng-practices/review/reviewer/standard.html)（官方工程实践，2026-08-12 查阅）
- [Google Engineering Practices：How to write code review comments](https://google.github.io/eng-practices/review/reviewer/comments.html)（官方工程实践，2026-08-12 查阅）
- [GitHub Docs：Changing the stage of a pull request](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/changing-the-stage-of-a-pull-request)（官方产品文档，2026-08-12 查阅）
- [GitHub Docs：Troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)（官方产品文档，2026-08-12 查阅）
- [GitHub Docs：Best practices for using GitHub Copilot](https://docs.github.com/en/copilot/get-started/best-practices)（官方产品文档，2026-08-12 查阅）
- [GitHub Docs：About GitHub Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review)（官方产品文档，2026-08-12 查阅）
- [GitHub Docs：Use Copilot code review across the PR lifecycle](https://docs.github.com/en/copilot/tutorials/use-copilot-code-review-across-the-pull-request-lifecycle)（官方产品教程，2026-08-12 查阅）
- [GitHub Docs：Review AI-generated code](https://docs.github.com/en/copilot/tutorials/review-ai-generated-code)（官方产品教程，2026-08-12 查阅）
- [GitHub Docs：Approving a pull request with required reviews](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews)（官方产品文档，2026-08-12 查阅）
- [Google Engineering Practices：What to look for in a code review](https://google.github.io/eng-practices/review/reviewer/looking-for.html)（官方工程实践，2026-08-12 查阅）
- 仓库证据：`README.md:256–261`、`.github/workflows/ci-gate.yml:3–144`、`docs/adr/0007-e2e-test-tiering.md:1–10`、`docs/specs/final-state-evidence.md:9–60`（2026-08-12 工作树）。
