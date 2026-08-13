# 05 — Focused Account Settings 与普通关闭保护

**What to build:** 把现有同时挂载所有内容的 Settings Page 改成单一 `/settings` route 下一次只呈现一个 Settings Section 的聚焦界面；首先为 Profile 与 Language 交付完整的来源返回、脏表单保护、保存中导航阻塞和普通窗口关闭语义，同时产生后续 Organization contributions 可消费的稳定 coordinator seam。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

**Consumes**

- 唯一顶层 `/settings` route 与 TanStack memory history。
- Profile Feature 现有权威读写与表单状态。
- Language Feature 现有即时设备持久化。
- Window platform owner 与现有普通 BrowserWindow close lifecycle。

**Produces**

- app-owned Settings coordinator interface，统一 Section switch、back、leave、Organization switch、picker entry 和 ordinary close intent。
- memory-history entry 中的 Section 与 source descriptor，以及 replace-current-entry 行为。
- Settings contribution lifecycle report，覆盖 clean、dirty、saving、command pending、unknown command result 和 Audit export active；本票以 Profile 的 clean/dirty/saving 作为首个真实消费者。
- Window platform 与 renderer coordinator 之间的 ordinary close request/decision seam。

**Owns**

- Settings Section 选择、source entry、navigation intent、discard confirmation 和 pending close 状态机。
- app/pages 中的 Feature contribution 组装；Settings 不成为 Feature 或 Domain。
- Window owner 仅传递 close intent；dirty/save 业务规则仍在 renderer coordinator 和对应 Feature。

**Acceptance**

- [ ] 从普通业务视图新进入 Settings 时默认为 Profile，且任一时刻只有一个 Settings Section 挂载。
- [ ] Profile 与 Language 选择只 replace 当前 Settings entry，Router Back 不回放 Section 点击历史。
- [ ] 两个都指向 `/`、但具有不同 history key 和 source descriptor 的 memory-history entry 都能返回它们各自的原始 entry，证明没有硬编码跳转 Home。
- [ ] source 仍存在且可进入时，Router Back 和“返回应用”经同一 intent 返回原 entry；source 失效时 replace 到 Home。
- [ ] Profile 每次 mount 重读权威值，使用 last-successful-write-wins；保存失败保留草稿并显示可重试错误。
- [ ] dirty Profile 在 Section switch、back、leave 和 ordinary close 前只显示“继续编辑”与“丢弃更改”；确认框不触发保存。
- [ ] Profile saving 期间禁止所有应用内导航 intent；ordinary close 等待结果，成功才继续，失败则取消关闭、保留 Settings 与草稿。
- [ ] Language 继续即时保存，永不进入 dirty confirmation。
- [ ] 离开 Section 卸载其 UI/request state；重进时重新读取；重启或崩溃恢复不恢复 Settings、Section、source 或草稿。
- [ ] `Settings Information Architecture Desktop E2E`、Desktop lint/typecheck/build 与 packaged localization 通过。
- [ ] 属于安全或 public interface 的产品代码前记录短实施计划；最后代码修改后绑定 final-state evidence 并关闭 finding ledger。

**Parallel classification:** full parallel; `parallel-ready` from the current fixed point.

**Absence test:** 所有 Organization 后续票永不实现时，Account Settings、source return、Profile lifecycle 和 ordinary close 仍可独立完整验收。

**Commutativity test:** 与 01–04、06 任意顺序合并都保持 main 完整且 CI 通过；与 02 的 Window 重叠只是机械性冲突。
