# ADR-0019: 生成状态机的边由 domain 转移表唯一裁决

## 状态

已接受 — 2026-09-07。来源为 2026-09-06 架构审查候选 B1 的拷问收敛。不重开 [#150](https://github.com/wsgbwps/nevix-ai/issues/150) 固化的状态机边集；[ADR-0012](0012-unified-ai-creation-owner.md) 的「状态机不得重开」与 [ADR-0016](0016-ai-creation-v1-trusted-seams.md) 的「本 ADR 不定义生成状态机」维持不变，本 ADR 只决定**裁决机制**的归属。

## 背景

边集由 #150 固化在 `domain/task.go` 的 `taskTransitions`/`jobTransitions` 转移表，但生产代码从不查询它们：散布在 worker 与 task_service 的十余个 `TransitionTask`/`TransitionJob` 调用点用 SQL from-set 表达边，且多数 from-set 只是「刚读到的状态」的乐观并发，并未断言具体边——边合法性纯靠调用方自律。同一「(task, job, outcome) ⇒ 走哪条边」的映射在 `process()`、`drivePoll()`、`driveCancel()` 三处 switch 各编码一遍；五份收敛写集装配（`persistJobTerminalInScope`、`convergeIndeterminate`、`convergeCreditBlocked`、`transferAndPersist`、`TaskService.Cancel` 内联）手抄同一套「job 边 → slot 投影 → task 终态 → 释放 reservation → retire 队列 → notify」，内部顺序与 lost-race 语义均已分叉（`drivePoll` 丢弃转移的 bool，`persistJobTerminalInScope` 对同样输法报错）。`application/` 零单测，收敛行为唯一的网是需要真 PostgreSQL 的 integrationtest。

投影与聚合（`SlotVerdictForJob`、`AggregateTaskStatus`）本就在 domain 且被生产使用；本决定是补全裁决入口，不是开启「把 worker 逻辑搬进 domain」的先例。

## 决策

### 裁决权归 domain

domain 提供两个纯函数，边合法性由构造保证（只产出表内合法边），调用点收敛后不存在绕过者，repo 层不再做表校验：

- `NextAction(KernelState) (KernelAction, error)` — 路由：下一步外部动作或守卫（含 terminal+terminal ⇒ park 等今天藏在 `default` 分支里的规则）。
- `VerdictFor(KernelState, KernelEvent) (KernelVerdict, error)` — 裁决：外部结果 ⇒ 写集数据；命名呼应 `SlotVerdictForJob`。

`KernelState` 六字段：`TaskStatus`、`CancelRequested`、`JobStatus`、`HasExternalRef`、`JobOutcome`、`SubmitAttempts`。slots 不进快照：settle 未决 slot + 聚合的写序天然幂等，`aggregateAndFinalize` 自守「全决才聚合」。

### application 只应用、不裁边

所有 `Transition*` 与 `BeginJobSubmitAttempt` 调用收进单一 verdict 应用例程（泛化 `persistJobTerminalInScope` 到非终态 verdict），`TaskService.Cancel` 的即时收敛同走此例程；`GenerationTaskRepository` seam 不变。worker 收缩为 claim → 读快照 → `NextAction` → 外部调用 → `VerdictFor` → apply，外部调用允许嵌在收敛中间（re-Poll、输出传输）。例程内事务重读新鲜状态构造 CAS from-set；ref 绑定与已就位状态的守卫写这类自环伪写，作为「可选边 + 纯守卫」表达，转移表不加自环边。

### 边界与既定裁决

- hold/pressure/backoff 等待、预算保持性 reschedule、notify（AfterCommit）留 application。
- 「提交尝试耗尽（`transientSubmitAttemptLimit = 4`）⇒ `JobFailed` 终态」是产出终态的状态机决策，随 `SubmitAttempts` 进快照移入 domain；等待多久留 application。
- lost-race 统一：非终态推进输 CAS = 容忍（下轮重读自愈）；终态收敛输 = 报错，靠下一轮 `process()` 的 terminal-park 分支自愈（现行为，已被 integrationtest 覆盖）。
- 写集顺序统一为 settle slot → 聚合 → 释放 → retire → notify；`convergeIndeterminate`/`convergeCreditBlocked` 的「先 `finalizeTask` 后 settle」直判路径退役——两条路径的聚合产出与直判终态完全一致（failed + indeterminate cause / failed 无 cause），差异仅在事务内崩溃窗口且两种顺序都自愈。`MarkCreditBlocked` 作为 verdict 携带的附加效果保留在例程首位。

## 后果

- 验收：`Transition*`/`BeginJobSubmitAttempt` 调用只存在于应用例程（repo 实现除外）；domain 新增三层单测——可达组合全枚举表驱动、crash 恢复入口钉死（submitting 无 ref 无 outcome ⇒ indeterminate、`transient_rejected` ⇒ 有界重提交、ref-less cancelling ⇒ fail-safe indeterminate、耗尽 ⇒ failed）、守卫规则显式化；integrationtest 全绿；diff 只落 `domain/` 与 `application/`，无 schema、契约或外部可见行为变化。写集顺序统一及等价性论证须在 PR 描述中明写。
- 排序：本重构先于 B3（参考素材流式传递，#161 视频里程碑的硬前置）落地；日历不允许时 B3 优先保 #161，本重构顺延不阻塞。
- 明确不做：不搬 `transferOutputs` 的输出分配逻辑（依赖传输 I/O 结果，留给集成覆盖；视频多输出需要时另立任务）；`CONTEXT.md` 不新增词汇（`KernelState`/`KernelVerdict` 是代码内部机械，非业务语言）；转移表不加自环边，repo 层不加表校验护栏。
