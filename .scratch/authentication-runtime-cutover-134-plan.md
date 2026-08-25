# Issue #134 — Authentication runtime cutover：实施计划

高风险变更（认证/会话面），按 AGENTS.md 要求先写本计划。
Fixed point：`main` @ f71ddb7。Spec：#132；前置 #133（internal seams）已 CLOSED 合并（#135）。
依据 ADR-0014（Go sole trusted data plane）、ADR-0015（Go authorization）、ADR-0004（renderer routing topology）。本切片不改变任何责任 seam，不需要新 ADR。

## Acceptance boundary

- 验收标准 = #134 的 23 项 acceptance criteria；父 spec #132 的 User Stories / Testing Decisions 为对照。
- 外部可观察行为不变（copy、表单行为、verdict 映射、持久化语义、并发纪律、routing topology）。
  允许的变化（规格明示）：Home 页不再解释 persistence health（session-persistence 通知转为 runtime 自渲染的全局 overlay，copy 不变）；内部 state/props/hook/文件组织自由重组。

## Primary Domain 与文件归属

- Primary Domain：Desktop Authentication（`apps/desktop/src/renderer/src/features/authentication/`）。
- 必要 app composition/route wiring：`app/App.tsx`、`app/routes/auth.tsx`、`app/routes/__root.tsx`、
  `app/startup-surface.ts`、`app/shell/app-shell.tsx`、`app/pages/home-page.tsx`、`app/settings/settings-page.tsx`、
  删除 `app/authentication-state.tsx`（context 改为 Feature-owned runtime context）。
- 直接受影响测试：`tests/component/authentication-transition.*`（删除，由 module tests 取代）、
  新 `tests/component/authentication-runtime*.spec.tsx` + fixtures、`tests/unit/startup-surface.test.mts`、
  被分类删除/调整的 `tests/auth/*.spec.ts` E2E 案例。
- 跨 Domain 说明：peer Features（profile / user-management）**零改动**——它们的 `GetSession` 已是
  结构窄 `{ token } | undefined` capability，app composition 直接传 `session.acquireSession`（结构类型匹配）。

## 接口设计（三个公共入口）

1. `AuthenticationProvider`（production Provider）：`{ serverUrl: string | undefined; children }`。
   无 URL 时 dormant（零 Authentication/persistence I/O）；首次配置 URL 永久绑定；同 document 内
   出现不同 URL 抛 composition error（不做 hot swap）。
2. `AuthenticationSurface`：零 props；内部消费 runtime context；available 时渲染 null。
   拥有 restore / restore-failure / setup probe / Instance Claim / sign-in / 自注册 / 强制改密 /
   表单验证 / 错误 / retry / pending / Remembered Email / unauthenticated 与 authenticated notices。
3. `useCurrentSession()`：两态 `{ status: 'unavailable' } | { status: 'available', user: {id,email,role},
   acquireSession(): Promise<{token}|undefined>, signOut(): Promise<void>, isSigningOut }`。
   restore/unauthenticated/claim/registration/password-change 全部对外 unavailable；无 partial User facts。

内部（不导出）：`model/use-authentication-runtime.ts`（依赖注入 ports 的状态机 + generation 纪律）、
`model/runtime-context.ts`、`ui/runtime-provider.tsx`（provider 核心 + authenticated notice overlays）、
`ui/test-authentication-provider.tsx`（Authentication-owned 测试组合，注入 in-memory adapters）、
in-memory adapters（#133 已备）。ports/adapter topology 不进 public index。

## 关键决策

1. **generation 纪律**：单一 `generationRef`，restore（含 retry）与绑定递增；所有 async completion
   （probe / restore / command / sign-out）先校验 generation 再写状态；probe 另有序列号防同代乱序。
   stale completion 不得覆盖新 surface、清除新状态或重建已结束 Session。
2. **acquireSession 每次调用读当前 runtime**（读 ref），sign-out / Session rejection 后旧 capability
   返回 unavailable；不缓存 token。结构与 peer `GetSession` 兼容 → peer 零改动。
3. **authenticated notices 归 runtime**：remembered-email 与 session-persistence 降级通知由
   runtime provider 渲染为 authenticated overlay（copy / role=status / at-most-once 语义不变）；
   Home 不再消费 persistence health。
4. **原子迁移**：删除 `useAuthentication`、`AuthenticationScreen` props relay、
   `app/authentication-state.tsx`、App 级独立 notice mount、`authentication-transition` story/spec；
   不留 compatibility alias。
5. **startup-surface 收敛**：`authenticationStatus` → `sessionAvailable: boolean`（top-level routing
   只看粗粒度可用性）。
6. **测试策略**：module tests（Playwright CT + in-memory adapters，经 window 控制通道脚本化
   延迟完成/乱序完成）覆盖 workflow、失败、single-flight、generation、ordering；HTTP/IPC/安全存储/
   Electron 安全留在既有 seam 测试；E2E 按「orchestration-only 删除 / real-seam canary 保留」分类
   （startup composition、session establish/restore、forced-password-change gating、sign-out、
   connection reload、平台 wiring）。

## 验证命令（先声明后动手）

- Targeted：`npm run test:component`、`node --experimental-strip-types --test tests/unit/startup-surface.test.mts tests/unit/authentication-in-memory-seams.test.mts`、`npm run typecheck`、`npm run lint`
- Full（首次 review 前）：`npm run test:unit`、`npm run verify:architecture`、`npm run verify:auth-artifacts`、
  `npm run test:e2e`（auth/session 变更 → PR 打 `full-e2e`；本地至少跑 `test:e2e:smoke` + retained auth canaries）
- CI gate：`gh pr checks --watch --fail-fast`；squash-merge 后 post-merge gate 自动。

## 范围外（不做）

- peer Feature 401 全局失效、共享 HTTP transport、generic selector/store、UI 重设计、route-per-step、
  Go Server/contract/schema 改动、hot server URL swap、`/me` 轮询、Session 显示名、兼容 facade。
