# 01 — 启动验证决策纯函数化：startup-resolution + startup-surface

**What to build:** 启动验证（ADR-0004：记忆有效直接进入 / 0 组织进 onboarding / 无记忆且仅 1 组织自动选中 / 其余进选择界面）的分支规则与顶层呈现/导航规则，从 provider 与 `__root.tsx` 的两个 useEffect 中收敛为两个纯决策 module，用户可观察行为逐像素不变。组织分支决策归 Organization Feature（model 层），呈现/导航决策归 renderer 组合根（app/ 层，消费 authentication status + onboarding eligibility + organization phase）。两个 module 仅 type-only 导入，决策矩阵由 node:test 单测穷举——隐式规则「记忆指向的 Membership 已结束 + 恰好剩 1 个组织 → 选择器（不自动进入）」首次获得显式断言。决策形状（来自 grilling 共识，即本票的决策记录）：

```ts
// Organization Feature：进哪个组织
resolveStartupBranch(memberships, rememberedId)
  → { kind: 'enter', membership } | { kind: 'picker' } | { kind: 'onboarding' }

// app/ 组合根：呈现什么、导航到哪
resolveStartupSurface({ status, isEligible, phase, hasActiveOrganization, pathname })
  → { navigate: '/auth' | '/onboarding' | '/select-organization' | '/' }
  | { render: 'restoring' | 'outlet' }
```

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 决策矩阵 node:test 单测全绿：branch 侧 5 条（记忆命中 / 记忆失权 / 无记忆单组织自动选 / 无记忆多组织选择器 / 零组织 onboarding），含「记忆失权 + 单组织 → 选择器」显式断言；surface 侧按 status × isEligible × phase × activeOrganization × pathname 组合穷举（含已在目标路由不重复导航、内容区路由不打扰）
- [ ] 两个决策 module 仅 type-only 导入（无 React / supabase client / runtime 依赖），node --test 可直接加载
- [ ] provider effect 与 `__root.tsx` 退化为执行器；render 与 effect 共享同一 useMemo 决策快照，`isRestoringOrganizationContext` 双写消除
- [ ] 行为保持红线：`OrganizationStartupPhase` 三态、failed 停留 restoring 语义、`isEligible` 状态机、`enterOrganization` 副作用（含 IPC 写设备记忆）全部不变；4 个顶层路由字面量集中为常量
- [ ] e2e 全部既有 spec 不动作回归网：`test:unit`、`run-e2e.sh` 全量、typecheck、lint、architecture 检查全绿
- [ ] apps/ 属 CI 门禁路径，走 feature branch + PR
