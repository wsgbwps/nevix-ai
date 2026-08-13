# 07 — Membership-verified Organization Settings

**What to build:** 为 Organization Settings 建立唯一、可用户观察的 Membership verification seam：进入 Members 时先验证当前 active Membership，明确区分 verified active Membership、confirmed Membership loss 和网络/服务错误导致的 unknown；不把不确定性误判为失权，也不让旧角色继续授权写操作。

**Blocked by:** 05 — Focused Account Settings 与普通关闭保护

**Status:** ready-for-agent

**Consumes**

- 05 产生的 Settings Section activation、navigation intent、forced transition 和 close coordinator interface。
- Organization Feature 现有 RLS-direct active Membership read、Active Organization state 与 access-lost flow。
- 现有 Members 读取与 Settings chrome 角色展示。

**Produces**

- Organization Feature-owned verification interface，对外只暴露 verified active Membership、confirmed loss 和 unknown 三种结果。
- Settings chrome、Members、后续 Organization Details/Audit/picker 可消费的 fresh Membership 与 role 投影。
- unknown 下的可重试状态、旧普通只读内容保留和 fresh-role action 禁用。

**Owns**

- Membership refresh 的请求代际、三态分类与单一权威解释。
- confirmed Membership loss、role reduction 和 Session 结束的强制安全转换；这些转换不等待 dirty confirmation。
- 其他 Organization contributions 必须消费此 interface，不得各自将 fetch error 解释为失权。

**Acceptance**

- [ ] 每次进入 Members Section 先刷新 Membership，Settings chrome 和 role-dependent controls 使用 fresh role。
- [ ] Membership 网络、超时或服务失败产生 unknown，不执行 Section fallback 或 access-lost flow。
- [ ] unknown 且已有成功载入的 roster 时保留该普通只读内容、显示无法验证说明，并禁用依赖 fresh role 的写操作。
- [ ] unknown 且无旧内容时显示可重试状态。
- [ ] 成功刷新确认 Membership 结束时，绕过 dirty confirmation、立即清除 Organization context 并走现有 access-lost 说明流程。
- [ ] 成功刷新确认 role 变更时，Settings chrome、导航与 Members controls 使用新角色。
- [ ] `Settings Information Architecture Desktop E2E`、既有 access-lost regression、Desktop lint/typecheck/build 与 packaged localization 通过。
- [ ] 产品代码前记录短实施计划；最后代码修改后绑定 final-state evidence 并关闭 finding ledger。

**Parallel classification:** stacked parallel behind 05; it is not `parallel-ready` at the current fixed point.

**Absence test:** 08–11 永不实现时，Membership-verified Members 读取、unknown 和 confirmed-loss 行为仍可完整验收。

**Commutativity test:** 不能与 05 交换合并顺序，因为消费 05 的 coordinator callpoint；05 合并后，可与 06 任意顺序合并。
