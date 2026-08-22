# ADR-0004: Renderer 路由拓扑——TanStack Router 仅覆盖顶层视图

## 状态

已接受 — 2026-08-04（2026-08-07 修订：Organization pre-shell 例外扩展为 onboarding 与组织选择两个路由，记录 identity-org-membership 定稿 spec 的启动三分支决策；2026-08-11 修订：pending Invitation 优先于自动进入，并从 RLS 数据恢复 Profile 完成状态；2026-08-13 修订：记录 app-owned Settings Page 的 authenticated 全屏聚合例外；2026-08-23 修订：用户系统迁移回收组织时代例外，路由清单收敛为 Connection Screen、认证面、App Shell 与 Settings Page，并把 Organization 时代的启动三分支叙述随 Feature 一并移除）

## 决策

Renderer 引入 TanStack Router（文件路由，memory history），routes 声明集中在 `renderer/src/app/`。路由粒度只覆盖顶层视图：Session 建立前的两个预认证路由——Connection Screen（`/connect`，设备尚无 Server URL 时由 connection Feature 呈现）与认证面（`/auth`，登录与首登强制改密，归 authentication Feature）——App Shell（主界面）与 Settings Page（设置页）。App Shell 内各业务 Feature 界面在内容区中拥有各自路由。

启动决策由 `resolveStartupSurface` 单点收敛：设备未配置 Server URL 时一律去 `/connect`；配置就绪后，除 `authenticated` 外的每个认证状态（含首登强制改密）都停留在认证面；已认证会话不回留任何预认证路由。保存 Server URL 后的文档重载（应用运行时 connect-src）从连接屏自然进入登录，不引入额外的路由迁移机制。Settings Page 是已认证上下文中的 app-owned 全屏聚合例外；它保持唯一 `/settings` 顶层路由，一次只组装一个 Feature contribution，不成为 Domain 或 Feature。认证流程内部的界面（登录表单、首登改密）不路由化，由 Authentication Feature 的状态机驱动。

## 取舍

react-router 是 Electron 生态更常见的选择，但全栈技术选型已固定 TanStack Router（文件路由），renderer 不引入第二个路由范式。认证流程路由化能获得声明式导航与深链，但必须把重发倒计时、flow 内状态传递迁入路由 state 或 search param；认证是模态式线性流程，从前进/后退导航中获益有限，迁移收益不抵回归风险。memory history 取代 URL 同步，因为 `file://` 协议下地址栏不可见，暴露路径没有价值。

## 后果

新增已登录界面默认在 App Shell 内容区内获得路由；预认证路由（Connection Screen 与认证面）不能承载 App Shell 导航或任何已认证数据，app-owned Settings Page 在 App Shell 之外组合当前账户的设置贡献。这两个明确例外不授权其他 Feature 创建全屏 authenticated route。认证 flow 界面永远不拥有路由，导航只能通过状态机迁移。路由库的更换成本随路由数量增长，本决定应当被视为长期约束。
