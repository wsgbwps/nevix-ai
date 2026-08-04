# 弃用 server/pkg/，跨 Module 共享一律放 internal/ 共享子包

`pkg/` 在 golang-standards/project-layout 中的语义是「可被 module 外部安全 import 的库代码」，但 `github.com/nevix-ai/server` 是自包含二进制，不存在外部消费者——迁移前 `pkg/event` 的全部 4 处引用都在同一 module 内，`pkg/` 不提供任何编译器或 API 边界收益。Go 官方文档《Organizing a Go module》对 server 项目的建议是所有逻辑放 `internal/`，通篇不使用 `pkg/`；project-layout 自身也声明 `pkg/` 有争议、非官方标准。决定：删除 `server/pkg/` 层，`pkg/event` 迁至 `internal/event`；今后跨 Module 共享基础设施一律建为 `internal/` 下的共享子包；仅当明确计划把某部分代码拆成独立 Go module 供外部仓库 import 时，才允许重新引入顶层库目录，且须以新 ADR 记录该计划。完整调研依据见 `docs/research/go-internal-pkg-directory-layout.md`。

本 ADR 取代 ADR-0002、ADR-0004 中对 `pkg/event/` 路径的引用（仅路径层面，两条 ADR 的决策本身不变）。

## Considered Options

- **保留 `pkg/event`**：唯一成立前提是「近期拆出独立库 module 供外部 import」，当前无此计划证据；保留即承担一个无收益的嵌套层（Dave Cheney 称之为与 `cmd/` 表面对称的 needless boilerplate），且 `pkg/auth`、`pkg/database`、`pkg/middleware` 空目录已违反 README「按需创建」的承诺。
- **迁至 `internal/platform/event`（Ardan Labs 模式）**：`internal/platform/` 面向多程序（多二进制）项目；当前 server 仅一个共享包、一个二进制，再包一层 `platform/` 属过度设计。
- **迁至 `internal/event`**：最小改动（4 处 import 路径），与官方对 server 项目「所有逻辑放 `internal/`」的建议一致；业务 Module 之间禁止互导的规则不受影响，`internal/event` 作为共享子包是唯一允许的跨 Module 依赖。
