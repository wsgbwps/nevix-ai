# 启动验证决策纯函数化计划

来源：/improve-codebase-architecture（PR #24–#28 走查）候选 B，经两轮 grilling 定稿。
报告：`$TMPDIR/architecture-review-20260807-203537.html`（临时文件，会话级证据）。

## 问题

「启动进哪个界面」是 ticket 04（PR #27）交付的核心业务规则，但当前：

- 分支决策锁在 `active-organization-provider.tsx` 的 useEffect 里（与 resolutionRef
  状态机、异步取数交织），呈现/导航决策锁在 `__root.tsx` 的 useEffect 里——
  只有 e2e 能碰到它们；
- `__root.tsx` 的 effect 导航条件与 render 条件（`isRestoringOrganizationContext`）
  双写，改一处忘另一处是一整类潜在 bug；
- 「记忆失权 + 单组织 → 选择器」这条规则靠条件顺序隐式表达，无显式断言。

## 决策（grilling 共识）

1. 两个分层纯决策 module，各归其主：
   - `resolveStartupBranch`：Organization Feature model 层。输入 memberships +
     rememberedId，输出 enter(membership) / picker / onboarding。
   - `resolveStartupSurface`：app/ 组合根层。输入 status / isEligible / phase /
     hasActiveOrganization / pathname，输出 navigate(目标) 或 render(restoring|outlet)。
   - 不合并为一个大函数（Membership 规则与路由拓扑变化原因不同）；surface 不放
     任何单 feature（输入天然跨 authentication / onboarding / organization，
     路由声明按 desktop ADR-0004 归 app/）。
2. 执行器变薄：provider effect 保留 resolutionRef 状态机、getSession、
   Promise.all、IPC，数据齐备后把 branch 输出翻译为 enterOrganization /
   beginOnboarding / setStartupPhase('ready')；RootView 改为 useMemo 单次求值 →
   effect 只执行 navigate → render 只读 render，双写从结构上消除。
3. 路由字面量 4 个（/auth、/onboarding、/select-organization、/）集中为常量；
   pathname 用开放 string，非匹配一律「不打扰」（内容区路由天然落此分支）。
4. 行为保持红线：OrganizationStartupPhase 三态、failed 永久停留 restoring、
   isEligible 状态机、enterOrganization 副作用（setState×4 + IPC 写记忆）不变。
5. 词汇复用 ADR-0004「启动验证」，CONTEXT.md 不新增词条。
6. 硬约束：两个决策 module 仅 type-only 导入（import type ActiveMembership），
   无 React / supabase / runtime 依赖——node --test 可加载的前提，评审拒绝项。

## 实施步骤

1. 新增 branch 决策 module + `tests/unit/startup-resolution.test.mts`（5 条用例）。
2. provider 接线：effect 删决策、留编排；enterOrganization 原样复用。
3. 新增 surface 决策 module + `tests/unit/startup-surface.test.mts`（组合穷举）。
4. `__root.tsx` 接线：useMemo 求值 + 执行器 effect + render 消费；路由常量集中。
5. 全量验证（见下）。

## 验证

- `pnpm --filter desktop test:unit`（新决策矩阵 + 既有 2 个 unit 测试）。
- `bash scripts/run-e2e.sh` 全量（52 passed / 4 skipped 基线不回退；Linux CI
  basic_text 导致的 skip 属预期）。
- typecheck / lint / architecture 检查 / prettier。
- CI：Desktop CI + Desktop E2E CI（smoke tier）绿后合并。

## 非目标（各自独立成票，本轮不做）

- failed 态显性化（phase 加 'failed' + 错误呈现/重试）——UX 决策，涉 Localized Surface。
- isEligible 改派生值——onboarding 资格所有权重议。
- e2e 场景向 unit 降级——需单独评估 Linux CI 环境约束。
- CONTEXT.md 词条、ADR 变更——词汇已有着落，无责任边界变化。
