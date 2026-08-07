# 04 — Active Organization：状态、设备记忆与启动三分支

**What to build:** Organization Domain（features/organization）的状态核心。org 状态存 renderer 内存，memberships 经 RLS 直读为唯一来源，无缓存层；remembered active org id 走主进程持久化 + organization domain IPC（循 ADR-0002/0003 先例），不落 localStorage。启动验证三分支：拉 memberships 后——记忆有效直接进入 / 0 组织进 onboarding / 1 组织自动选中 / N 组织进选择界面。组织选择界面采用定稿的 A 居中列表，含"创建组织"入口进 onboarding（邀请区由后续 ticket 补充）；选择组织后落点首页。记忆失效（Membership 已结束）时要求重新选择，绝不展示不再有权的数据。

**Blocked by:** 03 — Onboarding 向导 + Profile 读写 + Desktop 直连通道

**Status:** resolved — [PR #27](https://github.com/wsgbwps/nevix-ai/pull/27) 经 Desktop CI 与 Desktop E2E CI（smoke）门禁把关，于 2026-08-07 合并入 main（merge commit 4051bb3）

- [x] e2e：重启后 active org 记忆恢复，直接进入组织上下文
- [x] e2e：启动验证三分支（0 组织→onboarding / 1 组织→自动选中 / N 组织→选择界面）
- [x] 记忆的 Membership 已结束时回到选择流程，不渲染失权数据
- [x] remembered org id 不经 localStorage，持久化走主进程 + domain IPC
- [x] 全部新 Localized Surface 双语过发布检查；e2e 用例归入既有 tier
- [x] apps/ 属 CI 门禁路径，走 feature branch + PR

## Comments

验收结论（2026-08-07）：双轴审查（Standards / Spec）发现两个阻塞项并已修复闭环——(1) App Shell 组织上下文卡与路由守卫矛盾成死链，且 spec 页面归属指令将其划归 ticket 09 设置页侧栏，按移除方向修复，壳内组织名断言改为主进程设备记忆 id 断言（更强证据）；(2) 失权用例补 `@smoke` 归入 PR 门禁 tier。CI 阶段经 failure artifact 页面快照定位 restart 用例稳定失败根因：Linux runner 仅提供 basic_text safeStorage 后端，产品按设计不持久化会话，用例前提在 CI 永不成立（非 flaky）——复用 session-persistence 的 hasSecurePersistenceBackend skip 模式修复，helper 提取至 tests/helpers/electron-app.ts 复用。最终 Desktop CI（lint/unit、typecheck/build）与 Desktop E2E CI smoke tier 全绿后合并。
