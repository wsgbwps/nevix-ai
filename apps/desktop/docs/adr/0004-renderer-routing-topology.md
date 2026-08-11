# ADR-0004: Renderer 路由拓扑——TanStack Router 仅覆盖顶层视图

## 状态

已接受 — 2026-08-04（2026-08-07 修订：Organization pre-shell 例外扩展为 onboarding 与组织选择两个路由，记录 identity-org-membership 定稿 spec 的启动三分支决策；2026-08-11 修订：pending Invitation 优先于自动进入与注册后的临时 onboarding 信号）

## 决策

Renderer 引入 TanStack Router（文件路由，memory history），routes 声明集中在 `renderer/src/app/`。路由粒度只覆盖顶层视图：认证区、Organization 的 pre-shell 路由（onboarding 与组织选择）、App Shell（主界面）与 Settings Page（设置页）；App Shell 内各业务 Feature 界面在内容区中拥有各自路由。Organization pre-shell 路由是仅有的 authenticated 全屏例外，仅在 User 已验证且尚未进入 Organization 上下文时渲染，页面和状态仍归 Organization Feature 所有：启动时先完成 Membership 与 pending Invitation 的 RLS 验证，再决定路由；pending Invitation 优先于记忆有效直接进入、sole Membership 自动进入和零 Membership onboarding，因而进入组织选择界面。注册验证后的临时 onboarding 信号在这次验证完成前只显示 restoring；若发现 Membership 或 pending Invitation 则清除该信号，若零 Membership 且没有 pending Invitation 才进入 onboarding。之后用户在组织选择界面主动选择“创建组织”仍照常进入 onboarding。组织选择在需要人工选择时渲染，选定后进入 App Shell。认证流程内部的 login / signup / signup-verification / recovery 等界面不路由化，继续由 Authentication Feature 的 flow 状态机驱动。

## 取舍

react-router 是 Electron 生态更常见的选择，但全栈技术选型已固定 TanStack Router（文件路由），renderer 不引入第二个路由范式。认证流程路由化能获得声明式导航与深链，但必须把重发倒计时、flow 内状态传递（如 recovery 邮箱）迁入路由 state 或 search param；认证是模态式线性流程，从前进/后退导航中获益有限，迁移收益不抵回归风险。memory history 取代 URL 同步，因为 `file://` 协议下地址栏不可见，暴露路径没有价值。

## 后果

新增已登录界面默认在 App Shell 内容区内获得路由；Organization pre-shell 路由（onboarding 与组织选择）是唯一例外，不能承载 App Shell 导航或任何已选 Organization 数据。认证 flow 界面永远不拥有路由，导航只能通过状态机迁移。路由库的更换成本随路由数量增长，本决定应当被视为长期约束。
