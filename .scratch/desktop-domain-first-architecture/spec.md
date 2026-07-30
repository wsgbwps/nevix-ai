# Desktop Domain-first Architecture Migration Spec

Status: ready-for-agent

## Problem Statement

Nevix AI Desktop 已接受以 Domain locality 为第一组织轴的 Main 架构，但当前实现仍停留在旧的 Adapter-first 结构。Authentication Domain 的实现与 IPC adapter 分散在不同 ownership 范围；Language Mode 与 Interface Language 的行为分散在 `settings` 和 `i18n` 两套名称下；cross-process Channel、registration discovery 和共享类型仍反映旧拓扑。

这使维护者必须跨多个目录和竞争术语理解同一个 Domain，也让文档中的 canonical ownership contract 与可执行代码不一致。若只迁移其中一部分，Desktop 会同时存在旧、新 glob、Channel alias 或双重 Domain 名，增加隐性兼容层、注册遗漏和后续合并冲突。当前也没有一个自动化命令持续验证确定性的路径、import、public interface、registration、Channel prefix 和 generic preload 规则。

团队需要一个独立、原子、可验证且可回滚的 Desktop architecture migration，在不改变 Authentication、Session、Language Mode 或 Interface Language 产品语义的前提下，让实现与已接受的 ADR-0003 及 canonical Desktop 规则一致。

## Solution

将 Electron Main 的 Domain-owned IPC adapter 迁入其所属 Domain，使 `authentication` 和 `language` 成为所有实际存在 seam 上的 canonical Domain 名。Authentication Domain 保持当前设备 Session 生命周期行为；现有 `settings` 与 `i18n` ownership 合并为一个 Language Domain，同时保留 Language Mode 的设备本地持久化、启动解析、运行时热切换和 Interface Language fallback 语义。

在同一个变更中完成 Main topology、共享 IPC ownership、canonical Channel rename、renderer 调用更新和 registration discovery 切换。不保留旧 Channel alias、第二套 registration glob 或长期 Adapter-first 路径。Preload 继续只暴露 generic typed bridge primitives，composition root 只负责 Domain 初始化、IPC registration 和平台组装。

验收使用三个互补的最高层 seam：现有 Electron Playwright Authentication 与 Language 行为套件保持断言不变并证明外部行为未变；Node/web typecheck 与 production build 证明 declaration merging、preload typing 和 registration glob 可以共同编译打包；新增一个 Desktop architecture verification command 直接拒绝确定性的 ownership、import、public-interface、registration、Channel-prefix 和 generic-preload 违规。

## User Stories

1. 作为 Desktop 用户，我想在架构迁移后仍能注册、验证邮箱、登录和恢复密码，以便内部重组不改变 Authentication 体验。
2. 作为已认证用户，我想让当前设备 Session 在重启后按原有安全规则恢复，以便架构迁移不会让我意外退出或降低凭据保护。
3. 作为已认证用户，我想继续只退出当前设备，以便 Channel rename 不改变 Session 撤销范围。
4. 作为 Session 已失效的用户，我想继续回到本地化登录边界，以便结构迁移不会掩盖终止性恢复失败。
5. 作为遭遇暂时网络故障的用户，我想继续看到可重试的 Session 恢复状态，以便迁移不会把暂时故障误判为退出。
6. 作为 Desktop 用户，我想在未登录和离线时继续选择 Language Mode，以便 Language behavior 的 Domain consolidation 不引入账号或网络依赖。
7. 作为使用跟随系统模式的用户，我想让 Desktop 启动时继续按最高优先级系统语言解析 Interface Language，以便 Language Domain 重组不改变启动体验。
8. 作为简体中文用户，我想继续看到完整的简体中文 Localized Surface，以便 Channel 与 ownership rename 不造成资源缺失。
9. 作为英文用户，我想继续看到完整的英文 Localized Surface，以便结构迁移不改变支持语言承诺。
10. 作为选择非系统 Language Mode 的用户，我想让选择在当前设备重启后继续生效，以便持久化 ownership 移动不丢失偏好。
11. 作为切换 Language Mode 的用户，我想让当前运行中的界面、窗口标题和原生 Desktop surface 无需重启立即更新，以便 Language Domain consolidation 保留运行时语义。
12. 作为拥有损坏或未知 Language Mode 数据的用户，我想让 Desktop 继续安全回退到跟随系统，以便模块迁移不改变容错行为。
13. 作为使用不受支持系统语言的用户，我想让 Interface Language 继续回退到简体中文，以便 canonical Domain rename 不改变 fallback 契约。
14. 作为 Authentication Domain 维护者，我想在一个 Domain ownership 范围内找到 Session implementation 和 IPC adapter，以便相关知识、变更和验证具有 locality。
15. 作为 Language Domain 维护者，我想在一个 canonical Domain 下找到 Language Mode、Interface Language 和 Main adapter，以便不必在 `settings` 与 `i18n` 两套竞争术语之间跳转。
16. 作为 renderer Feature 维护者，我想通过 canonical Language Channel 访问 Language Domain，以便 cross-process interface 与业务词汇保持一致。
17. 作为 IPC Handler 作者，我想让每个 Channel 的 Handler 直接位于所属 Domain 的 IPC adapter 内，以便单个请求的入口容易发现且不增加无意义的嵌套层。
18. 作为 Domain implementation 作者，我想让 implementation 不依赖 IPC，以便 Domain behavior 可以独立于传输 adapter 理解和演化。
19. 作为 Main 外部 caller，我想只在确有外部调用者时通过 Domain public interface 使用其能力，以便 public seam 保持最小且有真实 leverage。
20. 作为跨 Domain 调用者，我想让依赖只能经过目标 Domain 的 public interface 且保持无环，以便 ownership 不被 deep import 绕过。
21. 作为平台代码维护者，我想让 window、updater 和 tray 保持明确的非-Domain owner，以便目录对称性不会制造虚假的业务 Domain。
22. 作为新增 Domain 的开发者，我想让符合约定的 IPC registration module 自动被发现，以便不编辑中央 registry。
23. 作为新增 Channel 的开发者，我想只修改所属 Domain 的共享类型和 Main adapter，以便团队的 vertical slices 保持物理隔离。
24. 作为 preload 维护者，我想让 preload 保持 generic typed bridge，以便新增 Domain 不需要增加 per-Domain preload implementation。
25. 作为类型维护者，我想让每个 Domain 通过 declaration merging 扩展 Channel map 并导出具名 request/response 类型，以便 cross-process interface 保持分散且类型安全。
26. 作为代码审查者，我想让 canonical Domain 名在共享 IPC、Main、renderer Feature 和 Channel prefix 中一致，以便命名偏差可以在合并前被发现。
27. 作为代码审查者，我想自动拒绝旧 Adapter-first Main 路径、旧 registration glob 和 legacy Language Channel，以便原子迁移完成后不会悄悄回退。
28. 作为代码审查者，我想自动拒绝 registration module 的加载副作用、异步或顺序依赖，以便 eager discovery 的行为保持确定。
29. 作为代码审查者，我想自动拒绝 Feature 外部 deep import、Feature 内部 self-import 和 peer Feature import，以便 renderer public interface 与隔离规则持续成立。
30. 作为代码审查者，我想自动拒绝 Feature public index 中的 wildcard export、implementation 和初始化副作用，以便 Feature interface 保持可发现且最小。
31. 作为代码审查者，我想让 legacy renderer segment 例外只能通过带原因和移除触发条件的 exact-path allowlist 存在，以便技术债只能缩小。
32. 作为维护者，我想让责任归属、interface depth、deletion test 和自定义 segment 理由继续由人工评审，以便自动化检查不伪装成架构判断。
33. 作为 CI 维护者，我想通过一个稳定的 Desktop architecture verification command 执行所有确定性规则，以便本地与 CI 使用同一验收入口。
34. 作为违反架构规则的开发者，我想收到包含规则、违规位置和修复方向的确定性诊断，以便无需阅读 verification implementation 就能修正问题。
35. 作为 verification command 维护者，我想用代表性的有效与无效 fixture 证明每类规则的通过和失败行为，以便检查器自身不会静默失效。
36. 作为构建维护者，我想让 Node/web typecheck 和 production build 在迁移后通过，以便新的 declaration merging、typed preload 和 glob 被实际工具链验证。
37. 作为测试维护者，我想保持现有 Authentication 与 Language Playwright 行为断言不变，以便测试继续表达用户契约而不是新目录结构。
38. 作为发布负责人，我想让迁移作为一个原子变更构建、测试、合并和回滚，以便不会发布双 glob、Channel alias 或一半完成的 Domain consolidation。
39. 作为仓库维护者，我想让所有移动和新增源文件落入 canonical Desktop ownership boundary，以便文档、实现和自动化检查保持一致。
40. 作为仓库维护者，我想让这次变更只处理已接受的 Desktop architecture migration，以便 Authentication public-interface deepening、Supabase refactor 和 renderer bulk rename 保持独立。

## Implementation Decisions

### Delivery and ownership

- 本规格是已接受 Desktop ADR-0003 的独立 architecture migration，不重新讨论或替代该 ADR。
- 迁移跨 Authentication Domain、Language Domain、各自的 cross-process interface、renderer caller、Desktop composition root 和 architecture verification supporting module，因此必须作为一个原子变更交付。
- Authentication Domain 是凭据验证与当前设备 Session 生命周期的 canonical owner。Language Domain 是 Language Mode 与 Interface Language 的 canonical owner。
- 每个移动或新增源文件使用其最窄 owner：Domain implementation 和 domain-local adapter 归相应 Main Domain；Channel interface 归相应 shared IPC Domain；renderer 调用归相应 Feature；只负责 wiring 的发现逻辑归 composition root；确定性规则归 Desktop architecture verification module。
- 平台职责 window、updater 和 tray 保持非-Domain owner，不因 Main Domain-first topology 创建镜像目录或伪 Domain。
- 不修改 Server、Supabase、Go trusted-execution seam、公共 OpenAPI contract 或持久业务数据。

### Atomic Main topology migration

- Domain-owned IPC adapter 从中央 Adapter-first ownership 移入所属 Main Domain。每个 adapter 的 registration module 直接属于该 Domain 的 IPC responsibility。
- 每个 Channel 只有一个直接嵌套的 Handler 文件；不保留或新增 `handlers` 包装目录。
- Registration module 加载时无副作用，只导出同步 `register(): void`；所有 registration 必须顺序无关。Domain 初始化、存储迁移、网络请求和其他启动行为不能由 registration module 触发。
- Composition root 显式初始化需要初始化的 Domain，并使用新的单一 Domain-first discovery pattern eager-load registration modules。它不包含 Domain business logic。
- 迁移完成后删除旧 Adapter-first registration ownership 与旧 discovery pattern。不增加兼容 glob、中央手工 registry 或临时双注册。
- 若未来 registration 出现真实顺序要求，应以新的架构任务改为显式 wiring；本迁移不通过文件名或 glob 返回顺序表达依赖。

### Domain interfaces and dependencies

- Domain adapter 可以依赖同 Domain implementation；Domain implementation 不得反向依赖 IPC。
- 只有存在 Domain 外部 Main caller 时才创建 Domain 根 public interface。Domain 自己的 adapter 使用内部相对 import，不绕经自己的 public interface。
- Main 中的跨 Domain dependency 只能经过目标 Domain public interface，并保持无环。
- 不创建空的 Main、shared IPC 或 renderer mirror directory 来表现不存在的 seam。
- 本迁移只改变 ownership 和 interface placement，不借机 deepening Authentication Feature public interface 或重构 Supabase implementation。

### Language Domain consolidation

- 原有 `settings` 与 `i18n` Main responsibilities 合并为一个 Language Domain；迁移后不把任一旧名称保留为竞争 Domain。
- 只承载 Language Mode 界面与资源的 renderer Settings Feature 同步成为 canonical Language Feature，使实际存在的 renderer seam 与 Main、shared IPC 和 Channel prefix 使用同一 Domain 名。
- Language Domain 继续在 Main 中持有设备本地 Language Mode，并继续负责从 Language Mode 与系统语言解析 Interface Language。
- Language Mode 的持久化格式、默认值、损坏数据处理、设备范围和离线可用性保持不变，除非完成原子重命名所必需的内部引用调整。
- Interface Language 的启动选择、热切换、窗口标题更新、简体中文 fallback 和 Supported Language 资源完整性语义保持不变。
- Feature-local localization resources 继续由各自 Feature 持有；Language Domain consolidation 不建立中央资源 Domain。
- Renderer 侧已存在的 Language behavior 可以进行完成 canonical Domain rename 所需的窄调整，但不触发 legacy segment 的机械批量迁移。

### Cross-process Channel interface

- Canonical Domain 名在所有实际存在的 seam 中保持一致：`authentication` 和 `language`。
- 所有 request Channel 使用 `<domain>:<action>` 命名。现有 Language-related Channel 原子改用 `language` prefix；不提供旧 `settings` 或 `i18n` prefix alias。
- Language Domain 的 canonical interface 包含 `language:get-bootstrap`、`language:get-language-mode`、`language:set-language-mode` 与 `language:language-mode-changed`。本迁移只统一 Domain prefix，不无故改写已准确描述行为的 action 名。
- Authentication Domain 继续使用 `authentication:read-session`、`authentication:replace-session` 与 `authentication:clear-session`。
- Authentication Channel 保持 `authentication` prefix 和现有请求/响应语义。
- 各 Domain 在自己的 shared IPC ownership 中通过 declaration merging 扩展 Channel map，并继续导出具名 request/response 类型。
- Shared Channel base 保持空 interface 聚合模型，不新增中央 Domain registry 或 augmentation barrel。
- Preload 继续只暴露 typed invoke/on primitives；不得出现 Domain import、Domain Channel 常量、per-Domain wrapper 或 central Domain list。
- Renderer caller 与 Main registration 在同一个原子变更中切换到 canonical Channel，因此任何提交状态都不依赖兼容 alias。

### Renderer Feature rules

- 本迁移不改变 renderer Feature 的 public-interface contract：Feature 外部只通过根 public index 导入，Feature 内部使用直接相对 import，peer Feature 互不 import，由 app 层负责组合。
- Feature 根 public index 只包含显式 named re-export，不包含 wildcard export、implementation 或初始化副作用。
- 新的通用 segment 只使用 `ui`、`api`、`model`、`lib` 和 `config` 责任词汇。
- 已存在的 `components`、`hooks`、`store` 和旧 Language placement 只在当前责任本身需要改变时机会式迁移。本规格不授权按外观进行批量 rename。
- 自动化规则需要容纳仍明确保留的 legacy renderer debt 时，只能使用 exact-path allowlist；每项记录原因与可验证的移除触发条件，且后续只能缩小。

### Desktop architecture verification

- 新增一个 Desktop-owned verification command，作为本地和 CI 可共同调用的单一确定性 architecture-check interface。
- Verification command 检查 Domain-first Main adapter placement、禁止旧 Adapter-first ownership、每 Channel 一个直接 Handler、禁止额外 `handlers` 层、Domain implementation 不依赖 IPC、Main 跨 Domain public-interface usage 和依赖无环。
- Verification command 检查 composition root 使用唯一 canonical discovery pattern、registration module 只提供允许的同步 registration interface、没有加载副作用或依赖注册顺序。
- Verification command 检查 shared IPC、Main、renderer 和 Channel prefix 的 canonical Domain name 一致性，并拒绝迁移后残留的 legacy Language Channel prefix。
- Verification command 检查 generic preload 不含 per-Domain implementation、import、Channel wrapper 或 registry。
- Verification command 检查 renderer Feature public index、Feature 外部 deep import、Feature 内 self-import、peer Feature import、根源码限制与新增 segment vocabulary。
- 检查器只自动化可从 filesystem、syntax 和 import graph 确定的事实。责任是否合理、Module 是否足够深、自定义 segment 是否通过 deletion test、是否应删除 legacy debt，仍由 review 决定。
- 诊断输出必须稳定、可操作，并包含违规规则、违规位置和期望形状；同一输入产生相同排序和退出状态。
- Verification implementation 保持 Desktop-local，不引入仓库级通用 architecture framework，也不为单一消费者设计插件系统。

### Rollout

- Main topology、Language Domain consolidation、Channel rename、renderer caller 更新、shared declaration 更新和 discovery glob 切换在同一 architecture migration 中完成。
- 不使用 compatibility Channel alias、双 glob、旧路径 re-export 或长期迁移 shim。
- 迁移提交必须能独立 typecheck、build、运行既有行为测试、运行 architecture verification，并可整体回滚到迁移前状态。
- 现有未提交 architecture documentation 是本规格的输入和 source of truth；实施者必须保留这些变更，不得还原或覆盖。

## Testing Decisions

### Test quality and primary seams

- 好测试只验证外部可观察的 contract，不锁定移动后的私有文件名、内部 helper、import 顺序或实现步骤。
- 最高行为 seam 是现有构建后 Electron Playwright Authentication 与 Language suites。它们穿过 renderer、generic preload、IPC registration、Main Domain implementation 和设备持久化，因此用最少的新测试表面积覆盖最多迁移风险。
- 现有行为 suites 的断言保持不变。只有 Channel rename 所要求的测试 harness wiring 可以更新；不得把外部行为断言改成新结构才能通过。
- 第二个 composition seam 是现有 Node/web typecheck 与 production build。它们验证 shared declaration merging、具名类型、preload global typing、renderer caller、Main discovery glob 和 electron-vite 打包可以共同工作。
- 第三个 seam 是新的 Desktop architecture verification command。它验证不能由用户行为 suite 可靠观察的确定性静态 contract，并作为 CI 的单一架构验收入口。

### Existing behavior coverage

- Authentication behavior 继续由现有 Electron Playwright suites 覆盖，包括登录边界、注册验证、密码恢复、Session 安全持久化、启动恢复、暂时故障重试、终止性失效和当前设备退出。
- Language behavior 继续由现有 Electron Playwright suites 覆盖，包括系统语言启动选择、未知或损坏 Language Mode fallback、离线可用、运行时切换、设备持久化、窗口标题和 Supported Language 资源 contract。
- 迁移不新增私有 Handler 单元测试来重复 Playwright 已覆盖的行为。若某个失败只能通过实现细节断言证明，应优先提升到现有 Electron seam。

### Architecture verification coverage

- Architecture verification command 自身使用最小的 fixture-driven tests，分别证明 canonical tree 通过以及每类确定性违规产生非零退出状态和可操作诊断。
- Fixture coverage 至少包括：legacy Adapter-first path、错误 discovery pattern、缺失或无效 registration export、registration loading side effect、额外 Handler nesting、Domain implementation 反向依赖 IPC、跨 Domain deep import、依赖环、Channel prefix 与 Domain 不一致、per-Domain preload code、Feature deep import、Feature self-import、peer Feature import、wildcard public export、新的非 canonical segment，以及不合规 allowlist。
- 每类规则只需要最小代表 fixture；不复制真实应用树，也不以快照整个诊断输出造成脆弱测试。
- 检查器的有效 fixture 应覆盖 Authentication Domain、Language Domain 和非-Domain 平台 owner 共存，证明规则不会把 Main 根目录的所有责任误判为 Domain。
- Allowlist tests 证明例外只能匹配 exact path、需要原因和移除触发条件、未知例外失败，并且 stable seam 与 canonical vocabulary 不能靠普通 lint disable 绕过。

### Required verification

- 运行 Desktop architecture verification command，并确认 canonical workspace 通过。
- 运行 verification command 的 fixture tests，并确认所有正反例通过。
- 分别运行 Node 与 web typecheck。
- 运行 Desktop production build。
- 运行现有 Language Electron Playwright suites。
- 运行现有 Authentication Electron Playwright suites，包括需要 disposable Supabase Auth harness 的完整行为套件；若平台原生安全存储能力导致既有条件性 skip，沿用当前证据策略，不通过降低断言绕过。
- 完成前运行 diff consistency checks，并核对所有 changed paths 仍属于本规格声明的 Desktop architecture、Authentication Domain、Language Domain、cross-process interface、composition root 或 verification supporting boundary。

### Prior art

- Authentication Electron Playwright suites 是 Session、IPC、安全存储和用户可见认证行为的现有最高 seam。
- Language Electron Playwright suites 是 Language Mode、Interface Language、窗口标题、持久化和 localization resource contract 的现有最高 seam。
- Desktop 现有 artifact 与 packaged-localization verification scripts 提供命令组织、确定性退出和可操作诊断的本地 prior art。
- 现有 package scripts 提供 Node/web typecheck、production build、Authentication E2E 和 localization verification 的组合入口；新的 architecture command 应沿用其简单、Desktop-local 的调用方式。

## Out of Scope

- 重新讨论、撤销或替代已接受的 Desktop ADR-0003。
- 恢复 Adapter-first placement，或比较另一套 Main topology。
- Deepening Authentication Feature public interface。
- 重构 Supabase client、Session store behavior 或 Authentication implementation。
- 改变注册、登录、邮箱验证、密码恢复、Session 恢复或当前设备退出的产品语义。
- 改变 Language Mode 选项、Interface Language 解析、fallback、热切换、持久化格式或 Supported Language 集合。
- 增加新的 Supported Language 或翻译 Localized Surface。
- Server、Supabase schema、RLS、Storage、Realtime、Webhook、PostgreSQL 或 Go trusted-execution seam 变更。
- 机械批量迁移 renderer 中所有 legacy `components`、`hooks`、`store` 或其他 segment 名。
- 为未来 Domain 创建空目录、central registry、per-Domain preload wrapper 或 speculative public interface。
- 将 Desktop architecture verification 扩展为仓库级通用 linter、可配置插件平台或跨 Server architecture framework。
- 自动判断责任归属、Module depth、deletion test、自定义 segment 正当性或架构变更是否获批。
- 在本规格编写阶段实施、提交或发布 source migration。

## Further Notes

- 本规格的 architecture authority 是 repository file-placement contract、Desktop executable rules、Desktop glossary、Desktop ADR-0003、由其部分取代的 IPC registration ADR，以及 Language Mode Main ownership ADR。实现不得从本规格复制的摘要推断新责任；出现冲突时以上述 source of truth 为准。
- Primary context 是 Desktop；这是一个已获架构决定授权的跨 Authentication Domain 与 Language Domain 原子迁移，而不是普通单 Domain feature slice。
- 测试 seam 已由交接上下文确认：保持 Authentication/Language Electron behavior suites 不变，以 typecheck/build 验证 composition，并新增一个确定性 Desktop architecture verification command。
- Feature-Sliced Design 的 slice/segment 与 public-interface guidance 支持本规格现有 renderer rules；repository contract 对 canonical Domain language、allowlist 和 review-only judgments 的约束更具体并优先适用。
- 当前工作树包含未提交的 architecture documentation。实施者应在开始和完成时检查工作树，保留这些用户变更，并只触碰本规格可追溯的 source、test、script 和必要 wiring。
