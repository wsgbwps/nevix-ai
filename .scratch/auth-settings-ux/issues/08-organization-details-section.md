# 08 — Organization Details 独立 Section 生命周期

**What to build:** 把 Organization name 从 Members 中移出，交付为一个每次进入都重读权威值的 Organization Details Settings Section；所有 active Member 都能查看，只有 fresh Owner 可编辑，并使用与 Profile 一致的草稿、保存、丢弃、导航和强制失权语义。

**Blocked by:** 05 — Focused Account Settings 与普通关闭保护; 06 — Organization Details Owner-only 安全闭环; 07 — Membership-verified Organization Settings

**Status:** resolved

**Consumes**

- 05 的 Settings contribution 与 clean/dirty/saving/discard/ordinary-close coordinator interface。
- 06 的 Owner-only Desktop presentation、trusted command 与 public contract。
- 07 的 fresh Membership/role 与 forced-security transition。
- Organization Feature 现有 Organization name RLS read 与 Active Organization projection。

**Produces**

- Organization Feature-owned Organization Details Settings Section contribution。
- dirty、saving、discard 和 forced-authority lifecycle report。
- 从 Members 移除后的单一 Organization name presentation/edit owner。

**Owns**

- Section mount、confirmed discard 与强制 role reduction 时的权威重读。
- Owner draft、last-successful-write-wins、save failure retry 和 Admin/Member read-only 表现。
- 名称表单对 Settings coordinator 的生命周期报告；不拥有全局导航状态机。

**Acceptance**

- [x] Settings 组织组显示独立 Organization Details Section，Members 不再挂载 Organization name form。
- [x] 每次进入 Organization Details 都先经 07 验证 Membership，再重读当前 Organization 权威名称。
- [x] Owner 可使用 06 的 trusted command 保存；Admin 与 Member 只读，三种角色都可见权威名称。
- [x] 同一 Owner 多设备修改使用 last-successful-write-wins，不增加 version、ETag、merge 或 conflict UI。
- [x] 保存失败留在 Organization Details，保留草稿并显示可重试错误。
- [x] dirty Organization Details 在 Section switch、back、leave 和 ordinary close 前进入统一丢弃确认。
- [x] saving 期间禁止应用内导航；ordinary close 等待结果，失败则取消关闭并保留草稿。
- [x] fresh verification 确认 Owner 被降权时不询问丢弃，立即清草稿、重读权威名称并显示只读表现。
- [x] `Settings Information Architecture Desktop E2E`、`Identity Organization Settings Authorization Integration` regression、Desktop lint/typecheck/build 与 packaged localization 通过。
- [x] 产品代码前记录短实施计划；最后代码修改后绑定 final-state evidence 并关闭 finding ledger。

**Parallel classification:** full parallel with 09 and 10 from the fixed point after 05, 06 and 07; mark `parallel-ready` only after those blockers resolve.

**Absence test:** 09–11 缺席时，Organization Details Section 仍能完整验收和独立回滚。

**Commutativity test:** 与 09/10 任意顺序合并都保持 main 完整且 CI 通过；从 Members 移除旧 name surface 的机械性重叠由 09 收口，语义仍属于 08。

## Implementation Plan

- 在 Organization Feature 内新增独立 Organization Details contribution，复用 07 的 Membership verification 结果与 06 的 Owner-only update command；不改变 trusted seam、contract 或数据库。
- 将 Organization Details 注册到 app-owned Settings Page composition，并从 Members presentation 移除 Organization name 表单；Settings coordinator 继续独占全局导航、丢弃确认和 ordinary-close 决策。
- 通过现有 Electron Playwright Settings seam 覆盖重新进入时权威重读、Owner draft/save/retry、Admin/Member 只读、dirty/saving 导航与关闭保护，以及 fresh role reduction 的强制清稿；完成 Desktop 静态检查、构建和 packaged localization 回归。

## Resolution

- Organization Details 已作为 Organization Feature-owned 独立 Section 注册；每次进入先验证 Membership，再由 Section mount 读取权威投影，Members 不再挂载名称表单。
- fresh Owner 使用既有 trusted command 与统一 Settings contribution 生命周期；Admin/Member 只读，unknown 保留已有草稿但禁写，confirmed loss/reduction 强制清稿且不会绕过更新后的 Section contribution。
- 延迟 Membership verification 使用 Section generation 失效保护，旧 Details 请求不能跨越到新的 Profile 草稿执行 forced switch。
- 验证通过：Desktop full E2E 96 passed / 5 platform skips；Settings E2E 10/10；lint、typecheck、58 unit tests、architecture、build:unpack 与 packaged localization。
- 初始 review 的 `CR-STANDARDS-0001`、`CR-SPEC-0001`、`CR-SPEC-0002` 及 repair-introduced `CR-STANDARDS-0002` 均在两轮 targeted re-review 限额内关闭；最终 Desktop authority security review 为 PASS。
