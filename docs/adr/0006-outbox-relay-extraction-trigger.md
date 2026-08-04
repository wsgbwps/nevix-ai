# Outbox 通用 relay 的拆分推迟到第二个消费者出现

identity 的 Outbox Worker 把通用投递机械（SKIP LOCKED 认领、退避调度、终态）与携码重试地平线（认领 SQL JOIN `identity.verification_codes`、码过期或作废即 cancelled）焊在一个 Worker 里。我们现在不拆：relay 只有一个消费者，按 ADR-0003「一个 adapter 是假设的 seam，两个才是真实的」，此时抽离是投机性通用性。本 ADR 记录拆分的触发条件与拆分时的所有权边界，避免未来读者把刻意的焊死当成疏漏，或在没有真实消费者时提前付抽象成本。

## 触发条件

当**第二个 Module 需要自己的 Outbox 表与投递 Worker** 时启动拆分——即投递机械即将被复制的那一刻。identity 内部的规则增长（第二种携码邮件、新的地平线规则）不触发拆分：机械只有一份，规则再多也是 owning module 的内部事务。

## 拆分时的所有权边界

- relay（认领、退避、终态）不认识任何业务表；
- 可投递性判定（地平线规则）留在 owning module，以 per-row 判定注入 relay；
- 禁止通过复制 Worker 机械接入第二个 Module。

## Consequences

拆分的机制——Go 接口形态、Outbox 表归属（每 module 自有还是共享）、共享包位置——留待触发时由第二个真实消费者塑形，本 ADR 不预设。与 `server/CONTEXT.md` 的关系：「Outbox Worker」词条维持现状（地平线属投递语义、由 Worker 执行）——本 ADR 分离的是规则内容的所有权，不是执行点。relay、可投递性判定等术语在触发落地、代码里出现真实 seam 时才收进词典。

## Considered Options

- **现在就拆**：为单一消费者引入投机性通用性，拆分形状只能凭空猜，违反 ADR-0003 的复杂度驱动原则。
- **彻底不记录**：第二个 Module 到来时最省事的路径是复制整个 Worker，地平线规则随之泄漏进通用投递机械，leakage 固化。
- **推迟但落书面触发条件（采纳）**：当下零改动；触发条件与所有权边界成为未来拆分时的防线，leverage 在第二个 Module 落地时兑现。
