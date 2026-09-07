# ADR-0006: Generation Parameter 四种表示由单一字段清单派生

## 状态

已接受 — 2026-09-07。经架构评审（2026-09-06）候选 A2 拷问定稿；本 ADR 记录决定，实施由独立任务承载，实施前按高险项规则在 `.scratch/` 写计划。

## 背景

同一群生成参数在四处逐字段手写：`ComposerDraft`（编辑中 Draft）、`LocalDraftRecord`（本地草稿记录，含 snake_case wire 形式）、`GenerationIntent`（提交意图 POST body）、冻结 Generation Specification 的解析视图；加上 manifest defaults 采纳、stale 适用性判定与 composer 参数菜单，新增一个参数约需 10 处手工同步，漏改既不编译失败也不测试失败。Capability Manifest 已按媒体发布各参数的候选与默认值，但菜单显隐与 stale 判定仍以 `media === 'image' / 'video'` 硬编码分支表达适用性。另有一处既有地雷：本地草稿解析对任何已知字段缺失整条判废，新增参数会使全部已存草稿静默失效。

## 决策

- AI Creation Domain 内建立单一 Generation Parameter 字段清单：静态字段描述表，每字段一行（字段 id、wire 键、类型、manifest 候选键、defaults 键）。具名接口保持手写，清单以 `satisfies` 与接口对账，由编译器保证同步。
- 下列运行时路径全部由清单派生：本地草稿的序列化与解析、submitTask POST body 映射、stale 适用性判定、参数菜单显隐与选项、manifest defaults 采纳。冻结规格解析视图复用清单的 wire 键，但其 fail-closed 严格性与 detail 级判废语义保持原位，不强求统一派生。
- 菜单显隐由 Capability Manifest 现有字段在场驱动（如 `durations` 有值才出现时长菜单），删除按媒体硬编码的参数分支；`ModeMenu` 的 video-only 显隐是产品语义（image 模式由引用有无隐式决定），保留显式条件，不入清单。Capability Manifest 契约不变，不改造为通用 parameters 数组。
- 解析兼容：比存储记录新的清单字段缺失读为 null，已存字段类型不符仍整条拒绝（[根 ADR-0017](../../../../docs/adr/0017-device-local-session-draft.md) 2026-09-07 修订）。
- 范围限 desktop renderer 的 creation feature：contracts/creation.yaml、Go 侧 GenerationIntent 与 manifest 投影仍是各自独立的权威表示，新增参数仍是三 seam 各改一次；YAML↔desktop 漂移防护属契约 seam 任务（评审候选 C1），不在本决定内。

## 取舍与约束

全类型推导（mapped type 派生全部类型）可把新增参数收敛到 1 处，但类型体操可读性差、报错不友好；表 + 具名类型对账是 2 处但零漂移风险，取后者。不引运行时 schema 框架或第三方校验库。清单自身也是一份手工表示——它换掉的是约 10 处分散同步，不消灭描述本身；ModeMenu 等产品语义门控明确留在清单之外，防止清单膨胀为 UI 配置。

## 验证

派生路径以单测覆盖：草稿记录 round-trip、新字段缺失的宽容解析、已存字段畸形的整条拒绝、stale 判定矩阵、菜单派生。既有 component 测试证明行为不变；不新增 E2E，不直读 contracts YAML（留 C1）。
