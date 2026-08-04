# Go `internal/` 与 `pkg/` 目录架构评估（nevix-ai server）

> Research date: 2026-08-04
> Research question: 个人开发者场景下，`server/internal` + `server/pkg` 的目录架构设计是否合理，业界专家如何设计 Go 项目结构？

## Summary of Conclusions

- **`internal/` 的使用是教科书式正确做法**：Go 官方文档明确推荐 server 项目将全部逻辑放入 `internal/`，且该约束由 Go 编译器强制（Go 1.4 起）。本仓库把全部业务 Module 放在 `internal/` 下，与官方建议完全一致。
- **`pkg/` 是当前设计中唯一与主流专家意见相悖的点**：project-layout 模板自身声明 `pkg/` 「not universally accepted」、Go 官方文档从未提及 `pkg/`、Dave Cheney 直斥其为「needless boilerplate」。对一个自包含二进制（非对外库）的 module，`pkg/` 不提供任何编译器层面的收益——本仓库 `pkg/event` 的全部 4 处引用都在同一 module 内部。
- **业界对个人开发者的共识是「极简起步、按需演进」**：从 `main.go` + `go.mod` 起步，按真实职责拆 `internal/` 子包。本仓库 `internal/identity` 的 `module.go` + `verification/` + `outbox/` 结构恰是 Ben Johnson「按依赖组织子包」的合理落地，约 2.2K 行的规模下不算过度设计。
- **`pkg/auth`、`pkg/database`、`pkg/middleware` 三个空目录（仅 `.gitkeep`）是推测性结构**：既违反仓库自身 README「按需创建，目前仅 event」的承诺，也违反 Cheney「默认不创建新包」的原则，建议删除。
- **建议（推断，非来源直接陈述）**：将 `pkg/event` 迁入 `internal/event/`（或 Ardan Labs 式 `internal/platform/`），删除空目录；若坚持保留 `pkg/`，应至少删除空目录并以 ADR 记录「未来拆出独立库 module」的明确理由。

## Detailed Findings

### 本仓库现状盘点（事实，来自仓库源码）

- Go module 路径为 `github.com/nevix-ai/server`，Go 1.26.3（`server/go.mod`）。
- 全 server 共 19 个 Go 文件、约 2,200 行（Glob 统计 `server/**/*.go`）。
- 目录现状（用户提供的目录清单 + 源码核对）：
  - `server/internal/identity/`：`module.go`（composition surface，33 行）+ `verification/`（码签发）+ `outbox/`（SMTP 投递 worker）+ `integrationtest/` + `mailpittest/`。
  - `server/pkg/event/`：`bus.go`（Event/Bus/InMemoryBus，38 行）+ `bus_test.go` + `types.go`（仅 1 行占位）。
  - `server/pkg/auth/`、`server/pkg/database/`、`server/pkg/middleware/`：**仅有 `.gitkeep`，无任何 Go 代码**。
- `pkg/event` 的全部引用点仅 4 处，且都在同一 module 内：`server/cmd/server/main.go:23`、`server/internal/identity/module.go:14`、`server/internal/identity/integrationtest/code_issuance_test.go:32`、`server/pkg/event/bus_test.go:6`（Grep 精确匹配 `nevix-ai/server/pkg/event`）。
- 仓库自身的架构契约：
  - 根 README 声明 `pkg/` 为「跨模块共享（按需创建，目前仅 event）」（`README.md`）——与三个空目录的存在自相矛盾。
  - `server/AGENTS.md` 规定：业务 Module 全在 `internal/<module>/`；`internal/A/` 不得 import `internal/B/`，Module 间经 `pkg/event/` 事件总线通信；「Put only genuinely cross-Module infrastructure in `pkg/`」。
  - ADR-0003 按复杂度决定分层深度，「出现第二个 adapter 时再拆」（`docs/adr/0003-complexity-driven-ddd-layering.md`）。

### 子问题 1：`internal/` 的官方语义与推荐用法

**结论：编译器强制语义 + 官方明确推荐，`internal/` 的用法无争议。**

- 语义（Go 官方规范）：「Code in or below a directory named 'internal' is importable only by code in the directory tree rooted at the parent of 'internal'.」该机制 Go 1.4 在主仓库启用、Go 1.5 起对所有仓库强制执行（[Go 1.4 Release Notes — Internal packages](https://go.dev/doc/go1.4#internalpackages)、[cmd/go — Internal Directories](https://pkg.go.dev/cmd/go#hdr-Internal_packages)）。
- 官方推荐（Organizing a Go module）：「Initially, it's recommended placing such packages into a directory named `internal`」「It's recommended to keep packages in `internal` as much as possible」；对服务器项目：「Server projects typically won't have packages for export... it's recommended to keep the Go packages implementing the server's logic in the `internal` directory」（[go.dev/doc/modules/layout](https://go.dev/doc/modules/layout)）。
- project-layout 同样确认：internal 模式「is enforced by the Go compiler itself」（[project-layout README](https://github.com/golang-standards/project-layout/blob/master/README.md)）。
- **对本仓库的评价（推断）**：`server/internal/identity/` 的用法与官方建议逐条吻合；`module.go` 作为 composition surface + 按职责拆 `verification/`、`outbox/` 子包，与 Ben Johnson「按依赖/职责组织子包」一致（见子问题 4）。此部分无需任何改动。

### 子问题 2：`pkg/` 目录在业界是否被质疑？官方模板自己怎么说？

**结论：被广泛质疑；project-layout 自身也明确标注它有争议，Go 官方文档则完全不使用它。**

- project-layout 自述（[README](https://github.com/golang-standards/project-layout/blob/master/README.md)，2026-08-04 抓取）：
  - 「This is a common layout pattern, but it's **not universally accepted** and some in the Go community don't recommend it.」
  - 「It's ok not to use it if your app project is really small and where an extra level of nesting doesn't add much value.」
  - 「The `pkg` directory origins: The old Go source code used to use `pkg`... and then various Go projects in the community started copying the pattern」（另引 [Brad Fitzpatrick 的 tweet](https://twitter.com/bradfitz/status/1039512487538970624) 作背景）。
  - 整个模板自述「**NOT an official standard defined by the core Go dev team**」；并对个人/PoC 项目明说「this project layout is an overkill. Start with something really simple instead (a single `main.go` file and `go.mod` is more than enough)」。
- Go 官方文档 [Organizing a Go module](https://go.dev/doc/modules/layout) 展示了从单文件到多命令、服务器项目的全部演进结构，**通篇未出现 `pkg/` 目录**，只有 `internal/` 与 `cmd/`。
- Dave Cheney（Go 核心团队，Practical Go, GopherCon Singapore 2019）：「This practice was never a recommendation, just a result of the original `Makefile` based build system... Other than a superficial symmetry with `cmd/`, putting packages in a `pkg/` directory is **needless boilerplate** and distracts from the potentially more useful `internal/` directory.」标准库 2014 年 9 月即已弃用该模式（[Practical Go 演讲](https://dave.cheney.net/practical-go/presentations/gophercon-singapore-2019.html)；另见 [Five suggestions for setting up a Go project](https://dave.cheney.net/2014/12/01/five-suggestions-for-setting-up-a-go-project)）。注：此段逐字引文经 explorer 通过演讲中文转译版核对，英文原版 PDF 未能直接打开，见 Open Questions。
- Kat Zień（2023 年自我修正）：「Do you use cmd / pkg directories? No... I realised they make the structure more complicated without bringing much benefit.」（[app-structure-examples README](https://raw.githubusercontent.com/katzien/app-structure-examples/master/README.md)、[JetBrains 访谈 2023-04-11](https://blog.jetbrains.com/go/2023/04/11/catching-up-with-kat-zien-on-the-structure-of-go-apps-in-2023/)）
- **对本仓库的评价（推断）**：`pkg/event` 放在 `pkg/` 的语义意图（project-layout 定义）是「可被 module 外部安全 import 的库代码」。但 `github.com/nevix-ai/server` 是自包含二进制，不存在外部消费者；`pkg/event` 的 4 处引用全部在 module 内部。因此 `pkg/` 在这里没有带来编译器或 API 边界上的任何收益，只是多了一层嵌套——正是 Cheney 批评的「superficial symmetry with `cmd/`」。

### 子问题 3：对个人开发者/单体项目，专家推荐的结构是什么？

**结论：各家高度一致——极简起步、按需演进；默认不创建目录。**

| 来源 | 对个人/小项目的推荐 | 出处 |
|------|------|------|
| project-layout | 「a single `main.go` file and `go.mod` is more than enough」 | [README](https://github.com/golang-standards/project-layout/blob/master/README.md) |
| Go 官方 | 演进阶梯：根目录单 package → 引入 `internal/` → 多二进制才引入 `cmd/` | [go.dev/doc/modules/layout](https://go.dev/doc/modules/layout) |
| Ben Johnson | 单 package 可支撑到约 10K SLOC；root package 放 domain types 且「should not depend on any other package in your application」，子包按依赖组织（`postgres/`、`http/`、`mock/`）；「Packages as layers, not groups」；结构中**无 `pkg/`** | [Standard Package Layout](https://gobeyond.ghost.io/standard-package-layout/)、[Packages as layers](https://www.gobeyond.dev/packages-as-layers/) |
| Dave Cheney | 「Prefer fewer, larger packages. Your default position should be to **not** create a new package.」 | [Practical Go 2019](https://dave.cheney.net/practical-go/presentations/gophercon-singapore-2019.html) |
| Kat Zień | Flat 起步；`cmd/` 单 main 时无价值；在其团队一切默认 internal，不刻意建 `internal/` 目录；五种结构按规模递进：Flat → Flat+Layer → Group-by-Module → Hexagonal → DDD-with-Events | [app-structure-examples](https://raw.githubusercontent.com/katzien/app-structure-examples/master/README.md) |
| Ardan Labs (Bill Kennedy) | 应用项目三件套 `cmd/` + `internal/`（内含 `platform/`）+ `vendor/`，**无 `pkg/`**；「Packages that need to be imported by multiple programs within the project belong inside the `internal/` folder」；同级 internal 包禁止互导 | [Package Oriented Design, 2017](https://www.ardanlabs.com/blog/2017/02/package-oriented-design.html) |

**对本仓库规模的映射（推断）**：server 约 2.2K 行、单一二进制、个人开发者。按上表，最小合理结构甚至可以是 flat；当前结构已包含 `cmd/` + `internal/` + 子包拆分，比最小结构超前，但每一处拆分（`identity/verification`、`identity/outbox`、未来的 `videogen` 四层）都对应真实职责且已由 ADR-0003 的「复杂度驱动」规则约束，**属于合理演进而非过度设计**。唯一没有真实职责支撑的结构就是 `pkg/` 层与三个空目录。

### 子问题 4：针对本仓库的具体改进建议（全部为推断，非来源直接陈述）

- **方案 A（推荐）——向专家共识收敛**：
  1. `server/pkg/event/` → `server/internal/event/`（import 点仅 4 处，改动极小）；跨 Module Domain Event 类型集中定义的规则不变，仅位置迁移。
  2. 删除 `pkg/auth/`、`pkg/database/`、`pkg/middleware/` 空目录——未来若真需要，按 Ardan 模式在 `internal/` 下建（或按 Kat Zień 的「everything is internal by default」直接建）。
  3. 同步更新根 README 目录树与 `server/AGENTS.md` 第 7、8 条规则；此变更触及架构契约（README 目录树 + 共享区域），按 `AGENTS.md` 需先在说明中记录影响与理由，建议附一条短 ADR。
- **方案 B（维持现状的最小修正）**：保留 `pkg/`（理由只能是「明确计划近期把 event bus 拆成独立 Go module 供其他仓库 import」——目前无此计划证据），但至少删除三个空目录以恢复 README「按需创建」承诺的自洽性。
- **不建议**：把 `pkg/` 扩充成通用工具层（`pkg/auth`、`pkg/database` 等预先占位的方向）。Ben Johnson 与 Cheney 均指出按「代码形式/技术类别」建包是循环依赖与命名冗余的来源（Johnson：按类型分组导致 `controller.UserController` 式冗余与 circular dependencies）；本仓库 `server/AGENTS.md` 的「genuinely cross-Module infrastructure」限制已与此精神一致，问题只在于位置选在了 `pkg/`。

## Source List

| Source | Type | Notes |
|--------|------|-------|
| [golang-standards/project-layout README](https://github.com/golang-standards/project-layout/blob/master/README.md) | 社区模板官方自述 | 非 Go 核心团队标准（其自述）；2026-08-04 抓取 |
| [Organizing a Go module — go.dev](https://go.dev/doc/modules/layout) | Go 官方文档 | 2026-08-04 抓取 |
| [Go 1.4 Release Notes — Internal packages](https://go.dev/doc/go1.4#internalpackages) | Go 官方规范 | internal 语义起源版本 |
| [cmd/go — Internal Directories](https://pkg.go.dev/cmd/go#hdr-Internal_packages) | Go 官方工具链文档 | 对应 Go 1.26.5 文档 |
| [Dave Cheney — Practical Go (GopherCon SG 2019)](https://dave.cheney.net/practical-go/presentations/gophercon-singapore-2019.html) | 专家原始演讲 | `pkg/` 批评出处；见 Open Questions |
| [Dave Cheney — Five suggestions for setting up a Go project](https://dave.cheney.net/2014/12/01/five-suggestions-for-setting-up-a-go-project) | 专家原始文章 | 2014-12-01 |
| [Ben Johnson — Standard Package Layout](https://gobeyond.ghost.io/standard-package-layout/) | 专家原始文章 | 约 2017；Medium 原文已迁移至此 |
| [Ben Johnson — Packages as layers, not groups](https://www.gobeyond.dev/packages-as-layers/) | 专家原始文章 | 2021-01-20 |
| [Ardan Labs — Package Oriented Design](https://www.ardanlabs.com/blog/2017/02/package-oriented-design.html) | 专家原始文章（Bill Kennedy） | 2017-02-28 |
| [Kat Zień — app-structure-examples README](https://raw.githubusercontent.com/katzien/app-structure-examples/master/README.md) | 专家原始仓库 | 2023 更新版 FAQ |
| [JetBrains — Catching up with Kat Zień (2023)](https://blog.jetbrains.com/go/2023/04/11/catching-up-with-kat-zien-on-the-structure-of-go-apps-in-2023/) | 专家访谈 | 2023-04-11 |
| `server/go.mod`、`server/AGENTS.md`、`server/CONTEXT.md`、`README.md`、`docs/adr/0003-complexity-driven-ddd-layering.md`、`server/pkg/event/bus.go`、`server/internal/identity/module.go` | 本仓库源码与契约 | 现状盘点依据 |

## Open Questions

- Dave Cheney 对 `pkg/` 批评的**英文原版逐字引文**未能从其演讲 HTML/PDF 原版直接抓取（explorer 经由该演讲的中文转译版核对，内容与多个独立转引一致，方向性结论可靠，逐字措辞标记为「unverified」）。
- Ben Johnson 的 Medium 原文（medium.com/@benbjohnson）已无法访问，当前引用自其迁移站 gobeyond；迁移过程是否有文字修订**unverified**。
- 「未来是否会把 event bus（或其他共享代码）拆成独立 Go module 供本仓库之外 import」只有仓库所有者能回答——这是 `pkg/` 目录唯一成立的前提条件；当前代码中未发现该计划的证据。
- Kat Zień「在其团队一切默认 internal、不刻意建 `internal/` 目录」是单一来源的个人实践陈述，未交叉验证到其他专家持完全相同观点（但与「按需演进」的总原则不冲突）。
